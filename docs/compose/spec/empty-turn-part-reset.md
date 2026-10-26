---
feature: empty-turn-part-reset
status: delivered
updated: 2026-10-20
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2695
---

# Empty Turn Keeps Message Identity

## Report

**What was built** — Dropping a think-only/empty step now clears that message's parts and keeps the message itself, instead of deleting the message and rebuilding a shell under the same ID. The retry writes into the surviving identity, the trigger condition and the retry request history are untouched, and the final persisted result is still exactly one assistant message carrying the retried answer. On the wire the sequence is now `message.part.removed` × N → `message.updated` → `message.part.updated`; no `message.removed` is published for a turn that will still deliver content.

The change removes the ambiguity that made downstreams lose the reply: a delete followed by a same-ID rebuild is byte-identical on the wire to a late frame of an already-deleted entity, so consumers that order by events (Mimo Desktop's session-state center) discarded the rebuilt content permanently — the whole turn vanished from the UI, survived session switching (history reads are gated by the same deletion fact), and only came back after an engine restart. It also aligns this branch with the retry cleanup that already existed in the same file (`Effect.tapError` removes parts, never the message), and as a side effect the transcript writer now learns about those part deletions instead of relying on an FK cascade that emitted no events.

**Verification** — `bun run typecheck` (repo root) PASS: `@mimo-ai/shared`, `@mimo-ai/plugin`, `@mimo-ai/sdk`, `@mimo-ai/cli` all clean. `cd packages/cli && bun test test/session` PASS: 1397 pass / 13 skip / 1 todo / 0 fail, 1411 tests across 125 files. After the review-driven edits: `bun run typecheck` PASS again, and `bun test test/session/invalid-output-continuation.test.ts test/session/retry.test.ts test/session/classify.test.ts` PASS: 151 pass / 0 fail. Regression proof is RED→GREEN: before the fix the new test failed with `expect(observed.removedMessages).not.toContain(assistant.info.id)` receiving the final assistant's own ID in the collected `message.removed` list; after the fix it passes with no removals. Independent review: no CRITICAL findings; two pre-merge items (stale `processor.ts` comment, unrecorded T3 results) and the inaccurate `isEmptyAssistantResidue` wording in [S2] were fixed and re-verified.

**Journey log** —
1. The same symptom was first attacked on the Desktop side by narrowing its deletion tombstone; two unit tests rejected it. Reads and events are two connections with no cross-connection ordering, so a tombstone is the only thing stopping a live event produced before a query-side prune from resurrecting the row.
2. The next attempt let a live `message.updated` lift the tombstone, on the theory that a rebuild must announce itself. A Desktop e2e fixture (`retiredFrame`) then rejected it: it builds exactly `message.removed` → same-ID `message.updated` → `part.updated` and requires all of it to be dropped. Rebuild and stale frame are indistinguishable by shape, so no consumer-side predicate can separate them.
3. That closed the question: the defect is the engine expressing "reset content" as "delete identity". `runLoop.dropEmptyAssistant` is safe by contrast — it deletes and then mints a *fresh* ID on the next step, so it never rebuilds under the same identity.
4. Reviewer caught that [S2]'s original exhaustion claim was wrong: on retry exhaustion `halt` sets `assistantMessage.error`, so `dropEmptyAssistant` bails and the error shell is kept — `isEmptyAssistantResidue` only runs on the resume path. Behaviour is unchanged there; the wording was corrected rather than the code.

## [S1] Problem

When an empty turn is dropped, `SessionProcessor.process` first calls `Session.removeMessage` to delete the whole assistant message, then `updateMessage` rebuilds a shell under the **same message ID** and hands it to `Effect.retry`. `ctx.assistantMessage` is constructed once in `SessionProcessor.create` and `Effect.retry` wraps the stream inside it, so the retry always writes back to the same ID.

The engine's stored data ends up consistent (a successful retry leaves one complete message in the database), but the event stream publishes `message.removed`. A downstream that orders by events cannot distinguish "deleted then rebuilt" from "a late frame of an already-deleted entity" — the two sequences are identical: `message.removed` → `message.updated` → `message.part.updated`. Mimo Desktop's center therefore discards the rebuild as a stale frame: the retried body never appears in the UI, switching sessions does not recover it (history reads are blocked by the same deletion fact), and only a restart with a fresh center restores it.

User-visible symptom: occasionally an entire assistant reply from one turn disappears while other messages and sidebar state stay normal, and a restart recovers it. The trigger rate follows how often the model emits think-only / empty output, so it reproduces rarely but across many users.

## [S2] Design

Dropping an empty turn becomes **reset the content, keep the identity**: delete every part of that message, keep the message itself, then reset `finish` / `error` / `time.completed` and hand back to `Effect.retry`.

- The event sequence changes from `message.removed` → `message.updated` → `message.part.updated` to `message.part.removed` × N → `message.updated` → `message.part.updated`.
- The message identity is unchanged across the retry, downstream no longer needs a "rebuild" concept, and the deletion fact is no longer misused to mean "this message was deleted".
- Aligns with the retry cleanup in the same file (`Effect.tapError`): that path already calls only `removePart` and never touches the message identity.
- Parts come from the `MessageV2.parts(ctx.assistantMessage.id)` snapshot already read inside `process` (covering every part of the message), not from `ctx.stepPartIds` (which holds only the current step), so multi-step turns leave no residue.
- The empty-shell terminal state is unchanged: on retry exhaustion `halt` writes `assistantMessage.error`, so runLoop's `dropEmptyAssistant` skips it and one error-marked empty assistant remains — the same as before the change. `isEmptyAssistantResidue` / `cleanupEmptyResidueAssistants` run only on the resume path and do not participate in this branch.

Unchanged contracts:

- The trigger condition (classification is think-only / invalid, `finish !== "length"`, not json_schema, `retrySafe`, no tool parts) stays the same.
- The history carried by the retry request stays the same (no reminder message is injected).
- The final persisted result stays the same: one assistant message carrying the body text, `assistantOnly(...).length === 1`.

## [S3] Out of Scope

- Do not change Desktop's deletion tombstone predicate. The tombstone is correct: reads and events are two connections with no cross-connection ordering, so it blocks old events that arrive after a deletion. This change only removes the engine-side misuse of "delete" to mean "reset".
- Do not change the other remove call sites (revert, compaction, resume trim, cleanupEmptyResidue, dropEmptyAssistant, tapError, REST DELETE): they are genuine deletions, and none of them rebuilds under the same identity.
- Do not raise the log level of `dropping empty turn`.

## Tasks
- [x] T1: Regression test locks the event stream — acceptance: after an empty-turn retry, the final assistant message ID never appears in `message.removed` events, empty-turn parts do not survive in the final message, and the test fails against the implementation before the fix (covers: S2)
- [x] T2: Switch the drop path to removePart — acceptance: T1 turns green and every existing `invalid-output-continuation` case stays green (covers: S2; depends: T1)
- [x] T3: Verify — acceptance: typecheck and the affected session test suite pass, with each command's result recorded (covers: S2; depends: T2)
