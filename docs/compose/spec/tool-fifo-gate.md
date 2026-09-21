---
feature: tool-fifo-gate
status: in-progress
updated: 2026-09-21
branch: feat/tool-fifo-gate
---

# Tool FIFO Gate

## Report

**What was built** — A FIFO admission gate in front of ordinary model-facing
local and MCP tool execution, keyed by `Instance.directory`. Only
`read`/`grep`/`glob` may run together. All other ordinary tools, including
`edit`/`write`, are exclusive. `actor`/`exec`/`workflow`/`session` bypass the gate
because they orchestrate or control nested execution. Exec guest tools remain
ungated; the model chooses `await` or `Promise.all`.

The gate has no filesystem resource keys or hook snapshots. Cancelling a queued
call removes its waiter. Admitted calls retain their slot until execution and
cleanup finish. `question` and `plan_exit` pass cancellation to the underlying
question wait, dismiss its UI request, and release the gate after cleanup.

**Verification** — Run from `packages/opencode`:
- Gate lifecycle and cancellation tests, plus real-session regressions for
  stopped writes, cancelled questions/plan approval, hook-rewritten writes,
  child-session joins, and ungated Codex exec.
- Existing agent, question/plan, GPT, tool-script, Responses custom-tool, and
  filtered session MCP/exec/Codex tests.
- Package `bun typecheck`, changed-file oxlint, and full-range `git diff --check`.

228 distinct relevant tests passed: 194 core/tool/question tests, 2 orchestration
tests, and 32 filtered MCP/exec/Codex/GPT tests. The first filtered run passed 31
and hit Bun's default 5-second timeout in the screenshot-resume case; that case
passed alone in 3.04 seconds using the repository test script's 30-second limit.
The final gate suite also passed all 30 cases after test-only assertion cleanup.
Package typecheck passed; changed-file oxlint reported 0 errors (46 existing
warnings in `session/prompt.ts`); full-range diff whitespace checks passed.

**Journey log**
- Synchronous token registration followed by interruptible admission is required;
  asynchronous acquisition inside `acquireUseRelease` makes queued waits
  uninterruptible. Unique tokens prevent colliding provider call IDs.
- Abort removes waiting calls only. An admitted command must finish cleanup
  before another conflicting tool starts.
- A persisted tool error is not proof that the detached execution fiber ended;
  cancellation must reach waits such as question/plan approval too.
- `session` joins/asks must bypass alongside actor/workflow/exec, or the parent
  can hold the directory gate while waiting for a child that needs it.
- Path-based write parallelism was removed after review exposed multiple identity
  and hook edge cases. The earlier design and tradeoff are preserved in S4.

## [S1] Problem

Multiple tool calls in one assistant step can execute concurrently. A file edit
can race a later `git commit` or `git push`, leaving changes out of the commit or
running commit/push in the wrong order. Ordinary model-facing calls need a
predictable execution order without requiring model prompts to teach scheduling.

## [S2] Design

### Scope and compatibility

One gate per `Instance.directory`; sessions sharing that directory share the
queue. It is process-local, not a filesystem or cross-process lock.

```text
compatible(a, b) ⇔
  a.tool ∈ {read, grep, glob} ∧ b.tool ∈ {read, grep, glob}
```

Every other ordinary tool is barrier-class: it cannot overlap another admitted
call, including a read or a second invocation of itself. Classification depends
only on the tool name, never on arguments, filesystem paths, or hook presence.

| Surface | Admission |
|---|---|
| Ordinary local `read` / `grep` / `glob` | Parallel with each other |
| Other model-facing local tools | Exclusive |
| Model-facing MCP tools | Exclusive |
| `actor` / `workflow` / `session` | Bypass so nested work/control cannot deadlock |
| Top-level `exec` and its builtin/MCP guest calls | Bypass; scripts own concurrency |

`session` must bypass because `ask` and `join` wait for child execution, while
approval/cancellation operations must remain reachable during that execution.
Nested ordinary model-facing leaf tools still enter the directory gate.

### FIFO and lifecycle

```text
enter(tool, callID, {signal}) → Promise<token>:
  mint unique token (call IDs may collide)
  bypass tools resolve without occupying a slot
  otherwise enqueue and tryAdmit()
  abort before admission → remove waiter, reject, tryAdmit()
  admission → detach queue abort listener

tryAdmit():
  consider only the FIFO head
  stop if it conflicts with any running request
  otherwise move it to running before resolving its promise
  continue while the next head is compatible

leave(token):
  remove/reject that queued waiter, or remove that running slot
  tryAdmit()
```

A queued barrier prevents later reads from jumping ahead. Double leave is
idempotent. A cancelled queued barrier permits compatible followers to proceed.
One gate entry is retained per directory for the process lifetime.

`gate.run` uses `Effect.acquireUseRelease`: synchronously register the token,
install release, await admission in the interruptible use phase, check the
caller's abort signal before starting the body, and release on every exit.
An admitted call is removed only after its body and cleanup finish; changing
its persisted status to failed is insufficient.

The question service receives the caller's AbortSignal from `question` and
`plan_exit`. Cancellation rejects the actual wait, removes the pending question,
and publishes `question.rejected`. Integration tests require the persisted tool
to be in the error state, the UI request to be dismissed, and later gated work
to proceed.

### Integration and prompts

Local and MCP model-facing wrappers hold admission across the existing execute
pipeline, including before/after hooks and permission checks. Hooks keep their
existing live loading behavior. MCP direct and exec guest surfaces share the
pipeline body; only the direct surface uses the gate.

No provider or AI SDK execution changes. Max-mode replay is already sequential.
Ordinary model/tool prompts omit cross-tool parallel/serial teaching. Advice for
sequencing shell commands within one `bash` call remains valid.

## [S3] Out of Scope

- Locking exec or changing model-chosen `await` / `Promise.all` behavior.
- Expanding GPT/Codex tool safety beyond checking for regressions.
- Cross-process or external-editor coordination, or coordination between distinct
  `Instance.directory` values.
- Provider stream reordering, AI SDK semantics, or bash command classification.
- Restoring parallel write admission in this emergency change.

## [S4] Previous Design and Why It Was Replaced

The earlier design also allowed `edit`/`write` to overlap when their canonical
file resource keys differed. Relative paths used the session directory; existing
files used realpath, and new files attempted to canonicalize their parent.
Reads still formed their own parallel class, and other tools were barriers.

Review and real-session/filesystem reproductions exposed these boundaries:

| Corner case | Why path-based admission was insufficient |
|---|---|
| Session directory differs from process cwd | A key can identify a different file from the one the tool actually accesses. |
| Earlier command retargets a symlink | Keys computed while queueing become stale before the writes start. |
| New-file aliases | A missing file has no final realpath; different spellings can later refer to one file. |
| Case-insensitive and Unicode names | ASCII lowercasing is insufficient: Greek sigma/final sigma and micro sign/Greek mu can alias on real filesystems. |
| Parent traversal and other filesystem aliases | Lexical path normalization can disagree with actual filesystem traversal; hardlinks add another identity dimension. |
| Before hooks rewrite `file_path` | Distinct original paths can become the same destination after admission; asynchronous hooks can reverse write completion order. |

We explored admission-time realpath refresh, conservative handling of unresolved
paths, and freezing before-hook callbacks with exclusive hooked writes. Those
approaches required additional identity rules and changes to hook refresh
semantics. They made a small scheduling optimization harder to reason about and
verify across supported filesystems.

The chosen emergency tradeoff is to serialize all ordinary writes and other
non-read tools. File edits are usually short compared with model token generation,
so the expected benefit of overlapping them is limited; formatters, LSP work,
and large independent write batches can make the difference larger. This is a
qualitative tradeoff, not a benchmark claim. Read/search parallelism is retained,
while the runtime no longer needs to prove that two writes target different files
or predict how hooks will rewrite them.

## Tasks

- [x] T1: Implement FIFO admission and unique tokens — acceptance: read/search concurrency, exclusive ordinary tools and FIFO head-of-line tests pass (covers: S2)
- [x] T2: Wrap local and MCP execute pipelines — acceptance: real-session ordering and cancellation regressions pass (covers: S2)
- [x] T3: Export the gate from the tool module — acceptance: consumers import the stable tool module path (covers: S2)
- [x] T4: Verify supported paths — acceptance: relevant tests, package typecheck and lint finish successfully (covers: S2, S3)
- [x] T5: Remove ordinary prompt scheduling instructions — acceptance: prompt tests pass and the live checkpoint writer follows the same contract (covers: S2)
- [x] T6: Simplify to read/search parallelism only — acceptance: edit/write serialize without resource keys or hook snapshots (covers: S2)
- [x] T7: Propagate cancellation to question waits — acceptance: question and plan_exit finish with error, dismiss the UI request and release the gate (covers: S2)
- [x] T8: Preserve the previous design and decision rationale — acceptance: S4 records reproduced corner cases and the performance tradeoff (covers: S4)
