---
feature: remove-task-gate-reentry
status: delivered
updated: 2026-06-08
branch: feat/remove-task-gate-reentry
commits: 37c3e1ef..37c3e1ef
---

# Remove TaskGate (re-entry + passive incomplete-task reporting)

## Report

**What was built** — Deleted the subagent completion gate entirely. Previously,
when a gate-eligible subagent finished with open/in_progress tasks it owned,
`TaskGate` re-entered the agent (up to 2 times) demanding `task done` /
`task abandon` and a re-emitted `**Status**/**Summary**` header; that re-emitted
text overwrote `deliveredText`, so the parent could receive a rewritten
conclusion. The passive layer (status downgrade to `partial`/`blocked`,
`incompleteTasks` list, `**Incomplete tasks**` body suffix) was removed in the
same pass: task DB is already the source of truth.

After the change, a subagent returns its original `finalText` and the model's
self-reported header status. `task/gate.ts` is gone. `completionGate` remains
only as the switch for `RETURN_FORMAT_INSTRUCTION` injection. postStop /
SubagentProgressChecker / written-at / preStop / `task_id` auto-start are
untouched.

**Verification** —
- `bun typecheck` in `packages/opencode` — PASS
- `bun test test/task/ test/actor/spawn-task-autostart.test.ts test/actor/execution-integration.test.ts` — PASS (44)
- `bun test test/agent/agent.test.ts test/actor/return-header.test.ts test/inbox/` — PASS (116)
- Independent review (general-2): spec compliance PASS, correctness PASS,
  no CRITICAL. Minor stale comments cleaned after review.

**Journey log** —
1. First analysis mis-identified the target as SubagentProgressCheckerPlugin /
   actor.postStop; user corrected to the pre-postStop completion gate (TaskGate).
2. Passive downgrade was initially kept ("提示 primary 的应该可以留"); user later
   judged it also useless and asked to delete it together — final scope is full
   TaskGate removal.
3. postStop must not replace the delivery body (TP-R14-11): `finalText` /
   `parseReturnHeader` target the preserved `deliveredText`, while hooks see
   `lastFinalText` only as input.

## [S1] Problem

When a gate-eligible subagent finished, `TaskGate` re-entered the agent (up to
`MAX_TASK_GATE_SUBAGENT_REACT` = 2) whenever it still owned open/in_progress
tasks. The nudge demanded `task done` / `task abandon` and then "re-emit your
final message starting with the **Status**/**Summary** header". The re-run's
`finalText` overwrote `deliveredText`, so the parent could receive a rewritten
conclusion instead of the subagent's original delivery.

Even the passive layer (status downgrade to `partial`/`blocked`,
`incompleteTasks`, `**Incomplete tasks**` suffix) was judged noise: task DB is
already the source of truth, and rewriting/annotating the delivery body for the
parent is unnecessary. Primary (`main`) has no equivalent stop-gate.

Progress checking (`SubagentProgressCheckerPlugin` / `actor.postStop`) is
unrelated and stays.

## [S2] Design

### Removed entirely

1. `task/gate.ts` (module deleted) and its tests.
2. TaskGate re-entry loop in `actor/spawn.ts` (nudge + re-emit + `deliveredText`
   overwrite + `gateFailed` + `MAX_TASK_GATE_SUBAGENT_REACT`).
3. Passive incomplete-task reporting: `reportedStatus` downgrade from task DB,
   `AgentOutcome.incompleteTasks`, `**Incomplete tasks**` body suffix.
4. `gateEligible` plumbing into `forkWork` (no longer needed there).

### Preserved

- `reportedStatus` / `reportedSummary` parsed from the model's `**Status**/**Summary**`
  header only (no DB-truth override).
- Delivery body is the main turn's `finalText`. postStop may re-enter for
  housekeeping but does **not** replace the delivery body.
- `RETURN_FORMAT_INSTRUCTION` injection and `parseReturnHeader` (waiter / group /
  notification consume them independently). `completionGate` config still
  selects which agents get the Status/Summary instruction.
- `SubagentProgressCheckerPlugin` / `actor.postStop` / `written-at` / checkpoint
  reconcile / preStop / `task_id` auto-start / memory-path-guard.

### Behaviour after removal

A subagent leaves owned tasks open/in_progress → returns the **original**
`finalText` and the model's self-reported status. No forced `task done` /
`task abandon` round-trip. No conclusion rewrite. No suffix. Task DB remains
the source of truth for unfinished work; the parent can list tasks if needed.

## [S3] Out of Scope

- Progress checker / `actor.postStop` / `written-at` / checkpoint reconcile.
- `RETURN_FORMAT_INSTRUCTION` / `parseReturnHeader` / notification semantics.
- Task tool UX, TaskRegistry schema, `task_id` binding / auto-start.
- preStop / splitover / goalGate.

## Tasks
- [x] T1: Delete TaskGate re-entry + passive reporting from `spawn.ts` —
  acceptance: no gate-driven `runAgentLoop`; delivery body never rewritten;
  `reportedStatus` is header-only; `incompleteTasks` gone. (covers: S2)
- [x] T2: Delete `task/gate.ts` — acceptance: module and imports gone;
  typecheck clean. (covers: S2; depends: T1)
- [x] T3: Update tests — acceptance: no re-entry / downgrade / suffix
  assertions remain; leftover-task cases assert delivery is untouched. (covers: S2; depends: T1, T2)
- [x] T4: Typecheck + run affected suites — acceptance: `bun typecheck` in
  `packages/opencode` passes; actor/task tests pass. (covers: S2; depends: T3)
