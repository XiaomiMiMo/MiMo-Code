---
feature: tool-fifo-gate
status: delivered
updated: 2026-09-20
branch: feat/tool-fifo-gate
commits: 1592084b..21e21e2c
---

# Tool FIFO Gate

## Report

**What was built** — A FIFO admission gate in front of tool `execute`
(local + MCP), keyed by `Instance.directory`. Concurrent: `read`/`grep`/`glob`
with each other, and `edit`/`write` when realpath keys differ. `apply_patch`,
`bash`, `task`, and all other tools are barrier-class (serial, including vs
themselves). `actor`/`exec`/`workflow` bypass the queue so nested tool calls
are not blocked by the parent. Enter uses unique tokens and AbortSignal
dequeue; leave runs via `Effect.acquireUseRelease`. Model-facing prompts no
longer teach cross-tool parallel/serial rules — runtime owns that.

**Verification** — From `packages/opencode`:
- `bun test test/tool/gate.test.ts test/agent/agent.test.ts` — PASS
- `bun typecheck` — PASS

**Journey log**
- `acquireRelease` + `flatMap` inside `run.promise` needs ambient Scope;
  `acquireUseRelease` is the Scope-safe form.
- `enter` must mint unique tokens (`callID#seq`); `"?"` fallback collides.
- Abort while queued must dequeue the waiter’s own token or the gate wedges.
- `actor`/`exec`/`workflow` must not hold the gate across nested waits.
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

`resource` for `edit`/`write` is `AppFileSystem.resolve(file_path)` (realpath
when the path exists). Missing `file_path` → barrier-class. Hardlinks are
ignored (residual risk accepted).

Barrier-class: `apply_patch` (multi-file), `bash`, `task`, MCP tools, and any
other tool not in the two parallel classes.

**Gate surfaces**

| Surface | Gate |
|---|---|
| Model-facing local `tool()` execute | Yes — always, except `GATE_BYPASS_TOOLS` |
| Model-facing MCP `item.execute` | Yes — always, except `GATE_BYPASS_TOOLS` |
| exec guest builtin (`def.execute` in tool-script) | No — never enters this wrapper |
| exec guest MCP (`execMcpTools`) | No — same pipeline body, no queue |
| `actor` / `exec` / `workflow` top-level | Bypass (nesting deadlock) |

MCP does not inspect its caller: two explicit registration surfaces share
`executeMcpBody`; only the model-facing one wraps `acquireUseRelease`.

### Queue / running protocol

```text
enter(tool, callID, {signal, resource}) → Promise<token>:
  token = `${callID}#${seq}`
  if tool ∈ {actor, exec, workflow}: return token   # bypass
  push waiter to FIFO queue
  tryAdmit()
  abort before admit → dequeue this waiter + reject
  abort after admit → leave(token)

tryAdmit():
  while queue non-empty:
    head = queue[0]
    if any running r with ¬compatible(head, r): break
    queue.shift()
    running.add(head)          # before resolve
    resolve(head)

leave(token):
  if still queued → splice that waiter only, tryAdmit
  else running.delete(token), tryAdmit
```

- FIFO head-of-line: a queued `bash` blocks later calls until it finishes.
- `leave` must run on success, tool error, permission deny, abort, and
  timeout via `Effect.acquireUseRelease`.

### Integration

In `session/prompt.ts`, registry and MCP `execute` wrappers:

1. `ToolGate.for(Instance.directory).enter(toolId, toolCallId, { signal, resource })`
   via `Effect.tryPromise` (AbortSignal dequeues on interrupt).
2. `Effect.acquireUseRelease(enter, body, leave)`.
3. `edit`/`write` pass `toolResource(tool, args)`.

No provider or AI SDK changes. Max-mode `replay` is already sequential.

### Error / lifecycle

- `enter` rejects only when AbortSignal fires before admission; that waiter is
  dequeued.
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
| `actor` / `exec` / `workflow` | Gate bypass (nested tools still gated) |

Possible later follow-ups: bash AST → readonly path resources; hardlink-aware
inode keys.

### Also out of scope here

- Provider stream reordering
- Cross-process locking
- Changing AI SDK execution semantics

## Tasks

- [x] T1: Add `packages/opencode/src/tool/gate.ts` FIFO gate — acceptance: unit tests cover readonly∥readonly, edit/write path isolation, barrier serial, FIFO HOL, abort, unique tokens, orchestrator bypass (covers: S2)
- [x] T2: Wire gate into `session/prompt.ts` local + MCP execute — acceptance: acquireUseRelease + tryPromise; edit/write pass realpath resource (covers: S2)
- [x] T3: Export gate from `tool/index.ts` — acceptance: tests import a stable path (covers: S2)
- [x] T4: `bun test` gate + agent prompt tests and `bun typecheck` — acceptance: commands exit 0 (covers: S2)
- [x] T5: Remove model-facing parallel/serial teaching from prompts — acceptance: agent tests assert absence (covers: S2)
