---
feature: tool-fifo-gate
status: delivered
updated: 2026-09-20
branch: feat/tool-fifo-gate
commits: 1592084b..HEAD
---

# Tool FIFO Gate (Worktree)

## Report

**What was built** — A worktree-scoped FIFO admission gate in front of tool
`execute` (local + MCP). Concurrent: `read`/`grep`/`glob` with each other, and
`edit`/`write` when realpath keys differ. `apply_patch`, `bash`, `task`, and
all other tools are barrier-class (serial, including vs themselves). Gate uses
unique admission tokens, AbortSignal dequeue on interrupt, and
`Effect.acquireUseRelease` so leave always runs. Model-facing system/tool
prompts no longer teach cross-tool parallel/serial rules — runtime owns that.

**Verification** — From `packages/opencode`:
- `bun test test/tool/gate.test.ts test/agent/agent.test.ts` — PASS (68 tests)
- `bun typecheck` — PASS

**Journey log**
- First wiring used `acquireRelease`+`flatMap` inside `run.promise` — Effect 4
  needs ambient Scope; `acquireUseRelease` is the Scope-safe form.
- `enter` must mint unique tokens (`callID#seq`); `"?"` fallback collides.
- Abort while queued must dequeue, or a later tryAdmit orphans a waiter in
  `running` and wedges the worktree.
- Expanded V1 mid-flight: edit/write path isolation is cheap once `compatible`
  takes an optional `resource`; apply_patch stays serial (multi-file).
- Prompt guidance is not a substitute for the gate — remove the restriction
  from model-facing text rather than document the scheduler.

## [S1] Problem

AI SDK `streamText` starts each tool `execute` as soon as that tool-call’s
arguments are complete (fire-and-forget), without waiting for the rest of the
step. High-TPS serving therefore runs co-emitted tools concurrently. Order-
sensitive pairs such as `edit` + `bash(git push)` have no happens-before:
push can miss the edit, or commit a half-written file. Low-TPS training often
serializes the same pair by accident, so policies learn “same-step multi-call
is fine” that is unsafe at serve time.

## [S2] Design

A worktree-scoped FIFO admission gate sits in front of tool execution.

### Gate key

One gate instance per worktree, keyed by `Instance.directory` (same notion of
worktree used elsewhere in the engine). Subagents and sessions sharing a
worktree share one gate.

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
when the path exists). Missing `file_path` or failed classification → treat
the call as barrier-class (incompatible with everyone). Hardlinks are ignored
(residual risk accepted).

Barrier-class (incompatible with the whole running set, including themselves):
`apply_patch` (multi-file), `bash`, `task`, `actor`, MCP tools, `exec`, and
any other tool. `apply_patch` stays serial on purpose: one call can mutate
many paths, so path isolation does not apply.

### Queue / running protocol

```text
enter(tool, callID, {signal, resource}) → Promise<token>:
  token = `${callID}#${seq}`   # unique even if callID collides
  push waiter to FIFO queue
  tryAdmit()
  abort before admit → dequeue + reject
  abort after admit → leave(token)

tryAdmit():
  while queue non-empty:
    head = queue[0]
    if any running request r with ¬compatible(head, r): break
    queue.shift()
    running.add(head)          # bookkeeping BEFORE resolve
    resolve(head)

leave(token):
  if still queued → splice + tryAdmit
  else running.delete(token) + tryAdmit
```

- Strict FIFO head-of-line: a queued `bash` blocks later `read` until bash
  has been admitted and finished — barrier order equals emission order.
- `leave` must run on success, tool error, permission deny, abort, and
  timeout via `Effect.acquireUseRelease`.
- Admission is synchronous; concurrent `enter` callers queue in arrival order
  (≈ model tool-call emission order under AI SDK’s sequential stream
  transform).

### Integration

In `session/prompt.ts`, every registry/MCP `execute` wrapper:

1. `ToolGate.for(Instance.directory).enter(toolId, toolCallId, { signal, resource })`
   via `Effect.tryPromise` (AbortSignal dequeues on interrupt).
2. `Effect.acquireUseRelease(enter, body, leave)` — Scope-safe release on
   success, error, deny, abort, and timeout (not bare `acquireRelease` +
   `flatMap`, which needs an ambient Scope `run.promise` does not provide).
3. `edit`/`write` pass `toolResource(tool, args)` (realpath of `file_path`).

No provider or AI SDK changes. Max-mode `replay` is already sequential and
need not call the gate.

### Error / lifecycle

- `enter` rejects only when its AbortSignal fires before admission; the waiter
  is dequeued so the gate cannot wedge.
- After `enter` resolves, `leave` must run (Effect `acquireUseRelease`).
- Double-`leave` is idempotent (delete on missing id is a no-op).
- Gate map grows one entry per worktree; dispose may clear the key but is not
  required for correctness.

### Prompt contract

Runtime owns admission safety. System/tool prompts must **not** explain the
gate or teach model-facing parallel/serial rules for cross-tool ordering.
Shell-internal sequencing advice (`&&` in one `bash`) remains valid.

## [S3] Out of Scope

### Follow-up (target form — not in this delivery)

| Class | Status |
|---|---|
| `read` / `grep` / `glob` | **Delivered** — parallel with each other |
| `edit` / `write` | **Delivered** — parallel when realpath keys differ |
| `apply_patch` | Serial (multi-file; path isolation does not apply) |
| `bash` / other mutate / unknown | Serial (has parallel benefit but needs resource analysis later) |
| `task` / fast local state | Serial (safe but no meaningful win) |

Possible later follow-ups: bash AST → readonly path resources; hardlink-aware
inode keys; training harness sharing the same gate.

### Also out of scope here

- Provider stream reordering
- RL / training harness wiring
- Cross-process or cross-machine locking

## Tasks

- [x] T1: Add `packages/opencode/src/tool/gate.ts` FIFO gate — acceptance: unit tests cover readonly∥readonly, edit/write path isolation, apply_patch/bash serial, FIFO head-of-line, abort-while-queued, unique tokens (covers: S2)
- [x] T2: Wire gate into `session/prompt.ts` local + MCP execute wrappers — acceptance: enter/leave via acquireUseRelease+tryPromise; edit/write pass realpath resource (covers: S2)
- [x] T3: Export gate from `tool/index.ts` if needed by tests — acceptance: tests import from a stable path (covers: S2)
- [x] T4: Run `bun test` for gate tests and `bun typecheck` in `packages/opencode` — acceptance: commands exit 0 (covers: S2)
- [x] T5: Remove model-facing parallel/serial teaching from default/subagent/bash prompts — acceptance: agent tests assert absence of those rules (covers: S2)