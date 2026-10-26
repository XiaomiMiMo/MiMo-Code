---
feature: retry-record-part
status: delivered
updated: 2026-10-22
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2703
---

# Retry Record Survives Until The Turn Succeeds

## Report

**What was built** — Every retry of an assistant step (request ladder, stream policy, auto-resume after tools) upserts one `retry` part on that assistant message, for the main agent and every subagent. The part carries the attempt count, phase, scope, kind, reason, hostCode and next-attempt time. It survives retry cleanup and empty-turn resets, and a record on a dropped empty step moves to the next step of the same user turn. It is removed only at the run loop's success exits (final answer, structured-output capture) for the user turns the run completed; failed, aborted, interrupted and compaction-stopped turns keep it. It never reaches the model. History indexing and export read the new shape. While a step is failing (a retry was recorded and no attempt has produced output since), a newer input in the actor's inbox lane supersedes the step: the retry wait or the hanging attempt ends, the step keeps only its record, and the run loop claims the input at its next step within the same run.

**Verification** — `bun run typecheck` PASS. `bun test test/session/invalid-output-continuation.test.ts test/session/structured-output-retry.test.ts test/session/message-v2.test.ts` PASS (includes main and subagent mid-turn records, success clearing, cancel and cancel-between-steps keeping, bounded exhaustion keeping, queued-prompt clearing, structured-output clearing, request-phase provider errors recovering with the desktop e2e retry config, model context exclusion, and supersede by a new input during a hanging retried attempt, during a request-phase wait, at the first retry of an input that arrived earlier, and on a subagent lane). The supersede cases run against one-minute retry delays and finish within seconds. `bun test test/inbox test/session test/actor`: 1779 pass; the failures are 5-second timeouts under full-suite load and pass in isolation, except one `prompt-effect` MCP test that passes or fails around its 5-second limit with no retry involved. Three independent review rounds on the record; the last found only MINOR items, all addressed. The retry-safe stream-failure case is covered by an attempt that streams reasoning and then an `upstream_error` frame: the record survives with attempt 2 and the dropped attempt's reasoning does not remain.

**Journey log** —
1. Clearing on every run exit was wrong: an interrupted turn whose last assistant finished with `tool-calls` looks successful by message state alone. Clearing moved to the run loop's explicit success exits.
2. Compaction returns the same `stop` for success and failure, so it is not a success signal.
3. `Log.create` caches by service name, so per-processor tags overwrite each other; processor log lines can carry another session's IDs.
4. Inbox inputs are claimed only at the top of the run loop, and a persistent retry stays inside one step, so a failing step has to give way to an input explicitly (S2.6).
## [S1] Problem

Retries are only visible through `session.status{retry}` and the `session.retry.attempt` bus event. The processor sets status back to `busy` on the retried stream's first `start` frame, before any content arrives, so the reconnect row disappears while the retried request may still produce nothing for many minutes. Status is session-wide and only the main agent writes it, so subagent and `checkpoint-writer` retries are never visible. Nothing is persisted: a refresh, session switch or restart during a retry shows a plain "processing" turn.

`MessageV2.RetryPart` is declared in the part union but no code writes it.

## [S2] Design

### S2.1 Part shape

`RetryPart` becomes the durable retry record of one assistant message:

```ts
{
  type: "retry"
  attempt: number          // latest attempt number for this assistant message
  phase: "request" | "stream"
  scope: "request" | "live-step"
  kind: RetryKind          // network | rate_limit | server | stream | unknown
  message: string          // decision.message, same text as session.status{retry}
  hostCode?: string
  next: number             // epoch ms of the next attempt
  time: { created: number; updated: number }
}
```

The unused `error: APIError` field is removed. The SDK types are regenerated; regeneration also picks up `UserMessage.task_id`, which the committed SDK was missing relative to the current schema. History indexing (`history/projection.ts`, `history/extract.ts`) and export redaction read `message` instead of the old error.

### S2.2 Writing

- Every retry notification for an assistant message upserts one retry part on that message: the processor's stream-phase `SessionRetry.policy` `set` callback, the request-ladder `onRetryStatus` callback, and the auto-resume-after-tools retry in `processor.ts`. One part per message, keyed by a part ID held in the processor context; later retries update `attempt`, `message`, `hostCode`, `next` and `time.updated` in place.
- It is written for every actor (main, subagents, `checkpoint-writer`, compaction). `session.status{retry}` and `Session.Event.RetryAttempt` keep their current behaviour for the main agent; `session.status` keeps its own session-level attempt count, while the part counts attempts of its assistant message.
- Max-mode candidate/judge retries do not write a part (they are not the user-visible step).

### S2.3 Surviving retry cleanup

- The retry part ID is never pushed to `ctx.stepPartIds`, so the `tapError` cleanup of a retry-safe failed attempt keeps it.
- The empty-turn reset (`processor.ts`, empty/think-only branch) removes every part of the message except retry parts.
- When `runLoop.dropEmptyAssistant` deletes a stale empty assistant, its retry part is carried to the next step's assistant of the same run when that assistant answers the same user message, so the count stays visible. If the run ends before such an assistant exists, the carried record is written back onto the newest assistant of that user turn on exit.
- A successful retried attempt does not remove the part; it stays visible above the recovered content until the turn ends.

### S2.4 Clearing

- Clearing happens only at the run loop's two success exits: the existing-assistant `final` classification and the structured-output capture. It runs after the goal gate and subagent wait, so a turn that re-enters keeps its records until it really ends.
- It removes every retry part of the actor whose assistant answers the run's first real user message or a later one (synthetic re-entries and queued prompts admitted into the same run belong to the completed work). The run's first real user message is the newest non-synthetic user message at or before the run's first `lastUser`, so a run resumed on a synthetic re-entry still covers its real turn. Retry parts are selected by one query filtering part type, actor, assistant role and `parentID` in SQL, without loading the slice.
- Failure, abort, interruption (including cancellation between steps, when the last assistant finished with `tool-calls` and no error), compaction stop (compaction reports success and failure with the same `stop`), text-loop give-up and blocked permission exits do not clear, so the turn still shows how often it retried.
- A later successful resume of the same turn clears them by the same rule.
- A step superseded by a newer input (S2.6) holds nothing but its record; clearing removes that empty assistant together with the record.

### S2.6 A newer input supersedes a failing step

Inbox inputs (steers, queued prompts, actor notifications) are claimed only at the top of the run loop. A persistent retry stays inside one step, so without this rule an input waits for the whole retry chain.

- The run loop gives each step's processor an `awaitNewInput` effect that completes once the actor's lane holds an accepted input no run has claimed (`listAccepted` checked on every `observeInput` revision).
- The processor tracks `retrying`: set when a retry part is recorded, cleared by the first `reasoning-start`, `text-start` or `tool-input-start` of an attempt. A step is failing while `retrying` is set. An attempt that produces output is processing again and is not superseded.
- The retried stream races a watcher. Once the input waits, the watcher wins at once if the step is failing, otherwise at the next recorded retry. The win interrupts the request-ladder sleep, the stream-policy backoff or the hanging attempt. The interruption is not a user abort: no `AbortedError` is written and no tool runs, since a failing attempt has produced no tool call.
- The superseded step removes its attempt's parts, keeps the retry part, clears `finish` and `error`, and is stamped `time.completed` so the orphan sweep never aborts it. Main sets `session.status` back to `busy`. `process()` returns `superseded`, and the run loop continues to its next step in the same run, where it claims the input. The record stays visible before the input until the run succeeds or ends without success.
- Compaction creates its processor without `awaitNewInput`, so a compaction step is never superseded. Max-mode candidate and judge retries are not the user-visible step and are not superseded.

### S2.5 Model context

`toModelMessages` never converts retry parts, and an assistant message whose parts are only structural (step markers, retry, empty text/reasoning) is skipped. A test locks this.

## [S3] Out of Scope

- Desktop rendering of the part is a Desktop change (turn-execution RUN-R7).
- `session.status{retry}` semantics, including the `start`-frame reset to `busy`, are unchanged; Desktop renders from the part instead.
- No retry part for max-mode candidate/judge scopes.

## Tasks
- [x] T1: Reshape `RetryPart` and regenerate the SDK — acceptance: typecheck passes with the S2.1 shape and the old `error` field gone (covers: S2.1)
- [x] T2: Write the retry part from stream and request retries for every actor — acceptance: integration test with two empty stops then text shows one retry part with `attempt` 2 and the empty-output message on the main assistant before the turn ends; a subagent run shows the same on its own assistant (covers: S2.2; depends: T1)
- [x] T3: Keep the part across cleanup — acceptance: after the empty-turn reset and a retry-safe stream failure the part still exists and no other residue survives (covers: S2.3; depends: T2)
- [x] T4: Clear on turn success, keep on failure/abort — acceptance: successful turn leaves no retry part; a structured-output turn and a turn whose recovered attempt streamed while a prompt was queued are cleared; cancelled turn keeps it with the last attempt; a turn cancelled between tool steps keeps it; bounded-exhausted turn keeps it next to the terminal error (covers: S2.4; depends: T2)
- [x] T5: Lock model context — acceptance: a request built from a history containing retry parts contains no retry content and no message created only from them (covers: S2.5; depends: T1)
- [x] T6: Verify — acceptance: repo typecheck and affected session/actor/server suites pass, results recorded (covers: S2; depends: T2, T3, T4, T5)
- [x] T7: Supersede a failing step with a newer input — acceptance: with one-minute retry delays, a prompt sent during a hanging retried attempt, during a request-phase wait, or before the first failure runs in the same turn within seconds; the next request carries both prompts; the superseded step shows only its record (completed, no error) until success, then is removed; the same holds on a subagent lane; a prompt queued after the recovered attempt produced text waits for that attempt (covers: S2.6; depends: T2, T4)
