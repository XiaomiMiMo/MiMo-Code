---
feature: checkpoint-capture-defect
status: in-progress
updated: 2026-06-20
branch: fix/checkpoint-capture-defect
commits:
---

# Checkpoint prefix capture defect containment

## Report

## [S1] Problem

Follow-ups from #2687. The prefix-capture closure that `SessionPrompt.layer`
installs into `prefixCaptureRef` is documented as best-effort, but
`Provider.getModel` and `Session.get` `throw` inside `Effect.fn`, which is a
defect. The closure guards them with `Effect.catch`, which only sees typed
failures. The defect escapes through `tryStartCheckpointWriter`, past
`prune.ts`'s `Effect.catch` and the runLoop's `fireCheckpoints(...).pipe(Effect.ignore)`,
and fails the user's current turn. `tool/session.ts` fork-query is exposed the
same way.

Secondary: `drainWriters` derives `timedOut` from `writers.size` after the wait.
The settle watcher deletes entries only after a DB write on a detached fiber,
and writers started during the wait are also counted, so the numbers can be
wrong (even negative `drained`). Return values are only logged today.

The F40 test in `checkpoint-drain.test.ts` claims to cover "drain pending" but
never settles writer1.

## [S2] Design

**Capture is total except for interruption.** The whole capture effect is wrapped
in `Effect.catchCause`: interrupts are re-raised, every other cause is logged
(`checkpoint prefix capture failed`) and the closure returns the empty prefix
(`{ system: [], tools: {}, inheritedMessages: [], parentPermission: [] }`) — the
same value it already returns for a typed miss. One boundary covers both
callers (checkpoint writer, fork-query) and any future step added inside the
closure. The existing narrower `getLanguage` guard stays.

**drainWriters classifies by Deferred.** It snapshots the `writing` Deferreds it
waits on and, after the bounded wait, counts `Deferred.isDone` over that
snapshot. `writers` map membership is no longer consulted for the result.

**F40 test covers pending.** The test's stub actor exposes its spawned outcome
Deferreds; the test settles writer1 and asserts that a second spawn happens
(the queued pending fires).

## [S3] Out of Scope

- Replacing the module-global `spawnRef` / `prefixCaptureRef` (prod has one
  runtime; only test contamination is affected).
- The check-then-register window in `tryStartCheckpointWriter` between
  `writers.get` and `writers.set` (not reproduced; would need a reservation
  mechanism).
- Changing `Provider.getModel` / `Session.get` to typed failures (wide blast radius).

## Tasks
- [ ] T1: Wrap capture closure in interrupt-preserving `catchCause` — acceptance: real `prefixCaptureRef.current` called with an unknown modelID and with an unknown sessionID succeeds with the empty prefix; new tests fail before the fix (covers: S2)
- [ ] T2: `drainWriters` counts via `Deferred.isDone` over the snapshot — acceptance: `checkpoint-drain.test.ts` hanging-writer case still reports `{ drained: 0, timedOut: 1 }`, and a settled writer reports `drained: 1, timedOut: 0` (covers: S2)
- [ ] T3: F40 test settles writer1 and asserts pending fires a second spawn (covers: S2; depends: T2)
