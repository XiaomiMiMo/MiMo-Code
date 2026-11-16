---
feature: fenced-run-livelock
status: delivered
updated: 2026-11-16
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2819
---

# Fenced run livelock

## Report

**What was built**

- A run whose inbox claims were all cancelled while it kept going (fenced)
  now stops at its next step instead of spinning on superseded retries. A
  waiting input on the main lane is then served by a fresh run with normal
  backoff.
- Boot reconciliation no longer treats claims of runs still alive in this
  process as crashed. A process-wide `liveClaimRuns` set protects them from
  claim to settle. This removes the cause of the fence seen on CI, and the
  same cause would have cancelled background subagents that outlive an
  `Instance.disposeAll()`.

**Verification**

- `test/session/fenced-run.test.ts`: fails without the `prompt.ts` change (the
  first run never ends within 10s). Passes with it, 3 runs in a row: exactly one
  request carries the second question.
- `test/inbox/queue-controller.test.ts`: the new live-run reconcile test fails
  without the controller change and passes with it. It checks that a live
  run's claim is kept, an orphaned claim is cancelled, and `ack` releases the
  entry. The file passes 21/21.
- `test/actor/execution-integration.test.ts` (four background actors across
  `Instance.disposeAll()`): failed with only the S2.1 change; passes now.
- Local run of 180 claim/receipt/inbox/actor/dispose-related files in one
  process: 2272 pass, 4 fail. All 4 failing files pass on their own, and the
  fenced-run failure (3 requests) led to the request-count change.
- PR CI at `f1fa929b`: lint, typecheck and unit shards 1–4 green. `typecheck`
  PASS after the final review fixes.
- Linux CI run with the original trigger set: `Log.flush()` went from 6.4s
  and then over 20s each to 0ms; CPU from 89.9s user to 36ms; registry tests
  from about 1.5s to about 0.14s each.
- Independent review, two rounds: no critical findings. Fixed from review: test
  timing, the stale-key cleanup in `settleClaims`, and the restart test now
  removes one key instead of clearing the set.

## [S1] Problem

A session run can lose its claimed inbox input while the run keeps going. The
input can be cancelled by a stop (`withStop` cancels accepted and claimed inputs
when it finishes) or by `reconcileOnBoot` from another controller, which cancels
"crashed" claims. If the provider keeps failing, the run spins without backoff:

- `awaitNewInput` (`prompt.ts`) supersedes a failing step's retry as soon as the
  lane holds any accepted input.
- The next step claims through `extendClaim`, which requires the run to still
  hold a claimed row. With its claims cancelled, it claims nothing, so the
  accepted input stays.
- So every retry is superseded at once, and every step fails at once. The loop
  never waits and has no step cap.

On CI this produced about 50 steps per second from a run that
`subagent-resume-negatives` left behind. Each step wrote dozens of log lines, so
the log queue fell behind at 3,700–4,700 entries per second, and later suites in
the same process hung (`task/registry`, `mcp/admission-completion-boundaries`).
In production the same state burns CPU, floods logs, and leaves the waiting input
unserved until the run ends.

## [S2] Design

### S2.1 A run that no longer holds a claim stops

At each step, when a run already holding receipts claims nothing new, it checks
whether any of its receipts is still `claimed` by its `runId`. Receipts stay
claimed until the run settles them at its end, so finding none means the run
was fenced: a stop cancelled its inputs, or boot reconciliation in a restarted
process did (S2.3). The run logs
`run lost its claimed input; stopping` and ends as an interrupted run, the same
way a stopped run ends. Settlement finds nothing left to acknowledge. If an input
is still waiting, the lane kick that is already waiting on this run starts a
fresh run, which claims the input and retries with normal backoff.

A fenced run stops even when no input is waiting. Its inputs are already
`cancelled/never_ran`, so there is nothing left for it to answer. On the main
lane the runner treats an interrupt as a normal end, so the waiting or remaining
kick starts the fresh run. On a subagent lane an interrupt also cancels the
actor, so a still-accepted input waits for the next accept or kick, and the
parent receives a cancelled notification. With S2.3, a run that is
still running is fenced only by a stop or an epoch bump, and both cancel the
waiting inputs too, so nothing is left stranded.

### S2.3 Boot reconciliation keeps claims of runs alive in this process

`reconcileOnBoot` treats every `claimed` row as left over from a crashed process
and cancels it. A run can outlive the Instance and controller that admitted it,
for example across `Instance.disposeAll()` after a config change. A later
controller then cancelled that live run's claims, which is how the CI run got
fenced. With S2.1 alone it would also cancel legitimate work (see Journey log).

A process-wide set `liveClaimRuns` (`inbox/controller-ref.ts`) records the
lane and run id each time `claim` claims rows. The entry is removed when the run
settles: `ack` removes it, and `settleClaims` also removes it when there is
nothing to ack or no controller is bound. `reconcileOnBoot` cancels only claimed rows whose run is not in
the set. A restarted process starts with an empty set, so restart recovery is
unchanged.

### S2.2 Testing

`test/session/fenced-run.test.ts` sets up this state through public APIs only:

1. A prompt fails with a retryable 503 under a one-minute retry delay.
2. `withStop(sessionID, Effect.void)` cancels the run's claim without
   interrupting the run.
3. A second prompt is accepted into the same lane.

Expected: the first run ends, and exactly one request carries the second
question: the fresh run's first step, after which it waits out the one-minute
retry. Across the whole test there are at most 4 requests (background requests
such as title generation may add some), not a burst. The test waits for this with a
10s bound instead of a fixed sleep. Without the fix, the first run never ends.

`test/inbox/queue-controller.test.ts`:

- "reconcileOnBoot keeps claims of a run still alive in this process until it
  settles them": the claim stays `claimed` through reconciliation, then `ack`
  settles it.
- The existing restart test now clears `liveClaimRuns` to stand in for a fresh
  process, and still expects `cancelled/never_ran`.

`test/actor/execution-integration.test.ts` ("new main messages preserve four
background actors…") covers the end-to-end case: four background subagents keep
running across `Instance.disposeAll()` and still succeed.

## [S3] Out of Scope

- Making `awaitNewInput` consider only inputs the current run can claim, and
  limiting how often one input can supersede retries. With S2.1 the run stops
  within one step, so these are optional defenses.
- Claims held by a live run in another process that shares the database; boot
  reconciliation still treats them as crashed, as before.
- Re-kicking a waiting input on a subagent lane after a stop-fenced run is
  interrupted.
- Moving `subagent-resume-negatives` back into the shared CI process.

## Tasks

- [x] T1: regression test reproducing the spin — acceptance: fails on main (first run still running after 1.5s) (covers: S2.2)
- [x] T2: stop a run that no longer holds any claim — acceptance: T1 passes with exactly two provider requests (covers: S2.1, depends: T1)
- [x] T4: boot reconciliation keeps live-run claims — acceptance: the new queue-controller test fails without the change and passes with it; the execution-integration background-actors test passes (covers: S2.3)
- [x] T3: no regressions in inbox, claim, receipt and supersede suites — acceptance: those suites pass (depends: T2, T4)

## Journey log

- Root cause found by instrumenting the log queue and the run loop on CI. The
  queue was not stuck: it fell behind a runaway loop (about 4,000 enqueued
  versus 500–900 written per second). The loop probe showed a main-lane run with
  2 receipts in memory whose database rows were `cancelled/never_ran`, an
  accepted `hook` input it could not claim, and `extendClaim` returning nothing
  at every step.
- The first PR CI run failed `execution-integration > new main messages
preserve four background actors awaiting model responses`: children ended as
  `cancelled` instead of `success`. That test calls `Instance.disposeAll()`
  while four subagents are still running, and the next prompt's
  `reconcileOnBoot` cancelled their claims as crashed. Before, they ran on and
  acked nothing; with S2.1 the fence check stopped them. So the boot
  reconciliation was the actual source of the fence, both here and on CI, and
  S2.3 fixes it at that point. The S2.1 check stays for runs fenced by a stop.
