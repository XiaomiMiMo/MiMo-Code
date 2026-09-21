---
feature: tool-fifo-gate
status: delivered
updated: 2026-09-21
branch: feat/tool-fifo-gate
---

# Tool FIFO Gate

## Report

**What was built** — A FIFO admission gate in front of tool `execute`
(local + MCP), keyed by `Instance.directory`. Concurrent: `read`/`grep`/`glob`
with each other, and `edit`/`write` when realpath keys differ. `apply_patch`,
`bash`, `task`, and all other tools are barrier-class (serial, including vs
themselves). `actor`/`exec`/`workflow`/`session` bypass the queue so nested tool calls
are not blocked by the parent. Enter uses unique tokens and AbortSignal
dequeue; leave runs via `Effect.acquireUseRelease`. The runtime owns admission
for ordinary model-facing leaf tools. `exec` and its guest tools remain ungated:
models choose `await` or `Promise.all` inside scripts.

**Verification** — From `packages/opencode`:
- `bun test test/tool/gate.test.ts test/session/tool-gate-cancel.test.ts test/session/tool-gate-orchestration.test.ts` — PASS
- `bun test test/tool/tool-script.test.ts test/tool/gpt.test.ts test/provider/openai-responses-exec-custom.test.ts test/agent/agent.test.ts` — PASS
- `bun test test/session/prompt-effect.test.ts --test-name-pattern 'MCP|exec|Codex|GPT'` — PASS
- `bun typecheck` — PASS

The regression tests cover cancelled writes through the real session pipeline,
session joins that need child tools to finish, cleanup before releasing a slot,
session-relative and symlinked paths, and ungated `exec` with `Promise.all`.

**Journey log**
- `acquireRelease` + `flatMap` inside `run.promise` needs ambient Scope;
  `acquireUseRelease` is the Scope-safe form.
- `enter` must mint unique tokens (`callID#seq`); `"?"` fallback collides.
- Abort while queued must dequeue the waiter’s own token or the gate wedges.
- `actor`/`exec`/`workflow`/`session` must not hold the gate across nested waits.
- Register the token synchronously and install release before awaiting admission.
  Passing an asynchronous acquire to `acquireUseRelease` makes the wait
  uninterruptible. The queue must also receive the caller's AbortSignal.
- Abort only removes waiting calls. Admitted calls retain their slot through
  execution and cleanup, and check cancellation before starting their body.
- Do not describe the gate as “worktree-scoped”; it is keyed by
  `Instance.directory`. Compose worktrees are only where the branch lives.

## [S1] Problem

Multiple tool calls in one assistant step can execute concurrently. When a
file `edit` races a `git commit`/`git push` in the same step, the commit can
miss the edit entirely, and commit/push may run in the wrong order relative
to each other or to the file write.

## [S2] Design

A FIFO admission gate sits in front of tool execution.

### Gate key

One gate instance per `Instance.directory`. Sessions that share that
directory share one gate.

### V1 compatibility predicate

Two safe-parallel classes; everything else is barrier-class:

```text
compatible(a, b) ⇔
  (a.tool ∈ {read, grep, glob} ∧ b.tool ∈ {read, grep, glob})
  ∨ (a.tool ∈ {edit, write} ∧ b.tool ∈ {edit, write}
     ∧ a.resource ≠ undefined ∧ b.resource ≠ undefined
     ∧ a.resource ≠ b.resource)
```

`resource` for `edit`/`write` resolves relative paths against `Instance.directory`,
matching the tools' actual working directory. Existing paths use realpath; new
files canonicalize their nearest existing parent. Missing `file_path`, dangling
symlinks, and unresolvable paths are barrier-class. Hardlinks are ignored
(residual risk accepted).

Barrier-class: `apply_patch` (multi-file), `bash`, `task`, MCP tools, and any
other tool not in the two parallel classes.

**Gate surfaces**

| Surface | Gate |
|---|---|
| Model-facing local `tool()` execute | Yes — always, except `GATE_BYPASS_TOOLS` |
| Model-facing MCP `item.execute` | Yes — always, except `GATE_BYPASS_TOOLS` |
| exec guest builtin (`def.execute` in tool-script) | No — never enters this wrapper |
| exec guest MCP (`execMcpTools`) | No — same pipeline body, no queue |
| `actor` / `exec` / `workflow` / `session` top-level | Bypass (nesting deadlock) |

MCP does not inspect its caller: two explicit registration surfaces share
`executeMcpBody`; only the model-facing one calls `gate.run`.

`session` bypasses admission because `ask` and `join` await child tool execution,
and approval/cancellation must remain available while child tools are running.

### Queue / running protocol

```text
enter(tool, callID, {signal, resource}) → Promise<token>:
  token = `${callID}#${seq}`
  if tool ∈ {actor, exec, workflow, session}: return token   # bypass
  push waiter to FIFO queue
  tryAdmit()
  abort before admit → dequeue this waiter + reject + tryAdmit
  admit → detach the queue abort listener
  abort after admit → execution cleanup still owns leave(token)

tryAdmit():
  while queue non-empty:
    head = queue[0]
    if any running r with ¬compatible(head, r): break
    queue.shift()
    running.add(head)          # before resolve
    resolve(head)

leave(token):
  if still queued → splice and reject that waiter only, detach listener, tryAdmit
  else running.delete(token), tryAdmit
```

- FIFO head-of-line: a queued `bash` blocks later calls until it finishes.
- `leave` must run on success, tool error, permission deny, abort, and
  timeout via `Effect.acquireUseRelease`.

### Integration

In `session/prompt.ts`, registry and MCP `execute` wrappers:

1. `ToolGate.for(Instance.directory).run(toolId, toolCallId, body, options)` receives
   the tool call's AbortSignal.
2. `acquireUseRelease` registers a token synchronously, awaits admission inside
   the interruptible use phase, checks cancellation, and runs the body. Release
   removes either the pending waiter or the running slot on every exit.
3. `edit`/`write` pass `toolResource(tool, args, Instance.directory)`.

No provider or AI SDK changes. Max-mode `replay` is already sequential.

### Error / lifecycle

- `enter` rejects when a pending waiter is cancelled by its AbortSignal or
  removed by the execution finalizer; compatible followers are reconsidered.
- After `enter` resolves, `leave` must run (`acquireUseRelease`).
- Double-`leave` is idempotent.
- One gate entry per `Instance.directory` for the process lifetime.

### Prompt contract

Runtime owns admission safety. System/tool prompts must **not** explain the
gate or teach model-facing parallel/serial rules for cross-tool ordering.
Shell-internal sequencing advice (`&&` in one `bash`) remains valid.

## [S3] Out of Scope

| Class | Status |
|---|---|
| `read` / `grep` / `glob` | **Delivered** — parallel with each other |
| `edit` / `write` | **Delivered** — parallel when realpath keys differ |
| `apply_patch` | Serial (multi-file) |
| `bash` / other mutate / unknown | Serial |
| `task` | Serial (no meaningful win to parallelize) |
| `actor` / `exec` / `workflow` / `session` | Gate bypass (nested model-facing tools gated; exec guest tools ungated) |

Possible later follow-ups: bash AST → readonly path resources; hardlink-aware
inode keys.

### Also out of scope here

- Provider stream reordering
- Cross-process locking
- Changing AI SDK execution semantics
- Locking `exec` or changing GPT/Codex scheduling; scripts retain their own
  `await` / `Promise.all` concurrency decisions

## Tasks

- [x] T1: Add `packages/opencode/src/tool/gate.ts` FIFO gate — acceptance: unit tests cover readonly∥readonly, edit/write path isolation, barrier serial, FIFO HOL, abort, unique tokens, orchestrator bypass (covers: S2)
- [x] T2: Wire gate into `session/prompt.ts` local + MCP execute — acceptance: synchronous token acquisition + interruptible admission; edit/write pass session-relative canonical resource (covers: S2)
- [x] T3: Export gate from `tool/index.ts` — acceptance: tests import a stable path (covers: S2)
- [x] T4: `bun test` gate + agent prompt tests and `bun typecheck` — acceptance: commands exit 0 (covers: S2)
- [x] T5: Remove model-facing parallel/serial teaching from prompts — acceptance: agent tests assert absence (covers: S2)
