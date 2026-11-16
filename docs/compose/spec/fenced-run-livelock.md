---
feature: fenced-run-livelock
status: in-progress
updated: 2026-11-16
source: fix/stale-claim-livelock
---

# Fenced run livelock

## Report

[Not finalized yet]

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
claimed until the run settles them at its end, so finding none means a stop or
boot reconciliation fenced the run. The run logs
`run lost its claimed input; stopping` and ends as an interrupted run, the same
way a stopped run ends. Settlement finds nothing left to acknowledge. If an input
is still waiting, the lane kick that is already waiting on this run starts a
fresh run, which claims the input and retries with normal backoff.

### S2.2 Testing

`test/session/fenced-run.test.ts` sets up this state through public APIs only:

1. A prompt fails with a retryable 503 under a one-minute retry delay.
2. `withStop(sessionID, Effect.void)` cancels the run's claim without
   interrupting the run.
3. A second prompt is accepted into the same lane.

Expected: within 1.5s the first run has ended, and the provider saw exactly two
requests (one per run). Without the fix, the first run is still spinning.

## [S3] Out of Scope

- Making `awaitNewInput` consider only inputs the current run can claim, and
  limiting how often one input can supersede retries. With S2.1 the run stops
  within one step, so these are optional defenses.
- Why `reconcileOnBoot` in a new controller can cancel the claims of a run that
  is still alive in the same process, and why `Instance.disposeAll()` does not
  stop runs started through `AppRuntime` in tests.
- Moving `subagent-resume-negatives` back into the shared CI process.

## Tasks

- [x] T1: regression test reproducing the spin — acceptance: fails on main (first run still running after 1.5s) (covers: S2.2)
- [x] T2: stop a run that no longer holds any claim — acceptance: T1 passes with exactly two provider requests (covers: S2.1, depends: T1)
- [ ] T3: no regressions in inbox, claim, receipt and supersede suites — acceptance: those suites pass (depends: T2)

## Journey log

- Root cause found by instrumenting the log queue and the run loop on CI. The
  queue was not stuck: it fell behind a runaway loop (about 4,000 enqueued
  versus 500–900 written per second). The loop probe showed a main-lane run with
  2 receipts in memory whose database rows were `cancelled/never_ran`, an
  accepted `hook` input it could not claim, and `extendClaim` returning nothing
  at every step.
