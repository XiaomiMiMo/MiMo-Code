---
feature: empty-output-persistent-retry
status: delivered
updated: 2026-10-21
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2703
---

# Empty Output Retries Persistently

## Report

**What was built** — `SessionRetry.decide` now classifies `InvalidOutputError` (empty or think-only step) as `kind: "server"`, so `budgetFor` applies the persistent server budget: no retry count, no wall-clock deadline, exponential backoff capped at 30 s. A turn whose upstream stalls or closes without content keeps retrying until usable output arrives or the user cancels, instead of failing after two attempts when one stalled attempt outlasts the former 15-minute `unknown` deadline. The retry reason stays "empty output", so the existing retry status and Desktop reconnect copy are unchanged.

**Verification** — `bun run typecheck` (repo root) PASS, re-run after review fixes PASS. `bun test test/session/retry.test.ts test/session/invalid-output-continuation.test.ts` PASS 118/118; the three new tests failed before the src change (kind `unknown`; 2 provider calls instead of 4; cancel test never reached the 5th call). `bun test test/server/session-recovery.test.ts test/error/host-registry.test.ts` PASS 147/147. `bun test test/session test/actor` 1661 pass / 10 fail: every failing file was rerun alone; spawn, checkpoint-splitover-integration, checkpoint-writer-wait-timeout, main-runloop-history-invariant, plan-reminder-dedup, processor-effect, revert-compact and title-first-turn pass; PRE-EXISTING flaky (also failing intermittently on a clean worktree at the base SHA): prompt-effect, steer-message-render-stable, structured-output-retry. The renamed spawn test passes after review fixes. Independent review: no CRITICAL findings; the cost and visibility consequences for non-main actors and deterministic empty output were recorded in [S2], and the compaction statement in [S3] was corrected.

**Journey log** —
1. The field symptom looked like an 8-hour hang; `time.completed` on an errored assistant is stamped by `sweepOrphanAssistants` at the next user prompt, so it measures user idle time, not the failure. Use the Desktop `closed` stage or the `halt` log time instead.
2. `halt` logs for these turns appeared under other sessions' IDs: `Log.create` caches by `service`, so `clone().tag()` mutates one shared `session.processor` logger and every processor logs the most recently created processor's `session.id`/`messageID`.
3. A second Anthropic-protocol client on the same provider saw the same upstream bursts ("stream ended without a stop reason", 5-minute idle timeouts) and recovered on its sixth attempt within 25 minutes, which is what persistent retry restores here.
## [S1] Problem

When a model step ends with no usable output (empty or think-only), `SessionProcessor.process` raises `InvalidOutputError` and `SessionRetry.policy` decides the retry. `decide` classifies it as `kind: "unknown"`, so `budgetFor` applies the bounded `unknown` budget: 8 retries within a 15-minute wall-clock deadline counted from the first failure.

Upstream Anthropic streams fail this way in bursts: a request returns HTTP 200, keeps the connection open with non-content frames for many minutes, and closes without a stop event. One such attempt can hold the stream for about 1000 seconds, which alone exceeds the 15-minute deadline. The turn then ends with "empty output" after only two attempts, although the same upstream recovers a few attempts later.

## [S2] Design

`SessionRetry.decide` classifies `InvalidOutputError` as `kind: "server"`. Empty output is a provider-side failure of an accepted request, the same recovery class as an overloaded upstream, so it uses the existing `server` budget: persistent mode, no retry count and no wall-clock deadline, exponential backoff from `initialDelayMs` (default 2 s) capped at `maxDelayMs` (default 30 s) with jitter.

- The decision stays `retryable: true` with the existing message (`error.data.message`, falling back to `"Empty model output"`), so the session retry status and the Desktop reconnect row keep showing the empty-output reason.
- Termination stays with the existing invariants: user abort/cancel interrupts the retry, `replaySafe` false (tool side effects) stops replay, and max-mode candidate/judge scopes keep their own bounded budgets.
- `retry.server` in config governs empty output from now on; `retry.unknown` no longer applies to it.
- Every caller of `SessionProcessor.process` gets the same policy: the main agent, subagents, `checkpoint-writer` and compaction summaries (`compaction.ts` runs its summary step through `process`). Only the main agent publishes `session.status{retry}`, so a background actor retrying empty output shows nothing in the UI, the same as its persistent 5xx retries today; `waitForWriterSettlement` stops waiting after its bound but does not cancel the writer.
- A request that deterministically yields empty output is retried until the user cancels, re-sending the full context on each attempt (about 120 attempts per hour at the 30 s cap). This is the accepted cost of not giving up on transient upstream failures.
- The trigger condition in `processor.ts` (think-only/invalid classification, `finish !== "length"`, not json_schema, `retrySafe`, no tool parts) and the part-reset behaviour from `empty-turn-part-reset` are unchanged.

## [S3] Out of Scope

- The SSE idle timer in `provider.ts` `wrapSSE` resets on any byte, so a stream sending only keep-alive frames is cut only by the upstream. Changing what counts as stream activity is a separate change.
- The Desktop reconnect row is cleared when the retried stream emits its `start` frame; its visibility rules are not changed here.
- Retry status for non-main actors and a give-up rule for deterministic empty output are not added.
- The compaction rollback in `compaction.ts` writes `InvalidOutputError` directly when no usable summary is produced; that write does not go through the retry policy and is unchanged.

## Tasks
- [x] T1: Failing tests — acceptance: `retry.test.ts` asserts `decide(InvalidOutputError)` is `{ retryable: true, kind: "server" }` with a persistent budget; an integration test with a bounded `retry.unknown` budget of one retry recovers after three consecutive empty stops; a cancel test stops a run of endless empty stops with an aborted error and no further provider calls; the first two fail on the current code (covers: S2)
- [x] T2: Classify `InvalidOutputError` as `server` in `SessionRetry.decide` and replace the bounded-exhaustion integration test — acceptance: T1 tests pass and the other `invalid-output-continuation` cases stay green (covers: S2; depends: T1)
- [x] T3: Verify — acceptance: repo typecheck and `bun test test/session` pass, results recorded (covers: S2; depends: T2)
