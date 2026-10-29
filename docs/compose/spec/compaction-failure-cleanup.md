---
feature: compaction-failure-cleanup
status: in-progress
updated: 2026-10-29
source: fix/compaction-failure-cleanup
---

# Compaction Failure Cleanup

## Report

## [S1] Problem

A manual `/compact` on a session whose last-used model was deleted fails with `ProviderModelNotFoundError`, yet the compaction boundary stays in the session forever without a `projection`. Clients render it as "compacting" indefinitely, and `filterCompacted` treats the orphan boundary as a cut point, so every later turn sees only an empty `Summary of previous conversation:` — the history is effectively lost.

Three defects combine:

1. `SessionCompaction.process` honours "a failed compaction leaves no boundary" only for its controlled `rollback` outcomes. Any failure, defect or interruption raised elsewhere in the step (model lookup, agent resolution, plugin hooks, message conversion, processor creation, the stream itself) exits without removing the boundary.
2. `POST /session/:id/summarize` always answers `true`. A controlled rollback ends the loop with `"stop"`, so clients are told the compaction succeeded when it did not.
3. Compaction summarises with the model of the last real user message, not the model the caller requested. A session whose previous model is gone can never be compacted onto a new one, and the requested model is silently ignored.

## [S2] Design

### S2.1 Every unfinished compaction is cleaned up

When `SessionCompaction.process` exits for any reason — success, typed failure, defect or interruption — and the step did not write the boundary's `projection`, the boundary user message is removed. If the summary assistant message was already created and carries no error, it is marked failed (`finish: "error"`, an error naming the cause) before the boundary is removed, mirroring `rollback`. The original exit is preserved: failures and defects still propagate to the caller, interruptions still interrupt. The cleanup itself is uninterruptible.

The existing controlled outcomes (no user message in history, overflow, text repeat, stop before summary, empty summary) keep their current behaviour; the new path is the backstop for everything else. A step that already wrote the projection is never rolled back, even if a later part of the step (auto-continue) fails.

Because this sits inside `process`, it covers every entry: the `/summarize` route, automatic overflow compaction for main and subagents, and fork overflow.

### S2.2 `/summarize` reports the real outcome

- Before touching the session, the route resolves the requested model. An unknown provider or model fails with `Provider.ModelNotFoundError` (HTTP 400) and no boundary is written.
- `SessionCompaction.create` returns the boundary message ID.
- After `prompt.loop` returns, the route reads that boundary. If the boundary is gone or its compaction part has no `projection`, the route fails with a new named error `SessionCompactionFailedError` (HTTP 500 through the default named-error mapping). Otherwise it returns `true` as today.
- Failures raised inside the loop keep propagating with their own error and status.

The success response shape is unchanged, so clients that already treat a non-2xx response as failure need no change.

### S2.3 Compaction uses the requested model

The compaction step's base model is the boundary message's own `model` — the model passed to `create` (the `/summarize` request model, or the current turn model for automatic compaction). The last real user message's model is used only when the boundary carries none.

- Non-overflow compaction summarises with the base model. Overflow compaction with a configured compaction-agent model keeps using that model, unchanged.
- The prefix snapshot profile key is built from the base model. When the model is unchanged the snapshot is reused as today, keeping prompt-cache hits. When the model changed the snapshot is absent and compaction proceeds with no tools, the path `llm.ts` already supports for compaction; provider caches are per model, so nothing reusable is lost.
- The summary message `variant` comes from the last user message only when it used the same provider and model as the base model; otherwise it is the boundary's own variant.
- The preserved tail is budgeted with the base model, the model the following turns will use.

## [S3] Out of Scope

- Orphan boundaries already persisted by earlier versions are not repaired; `filterCompacted` semantics for in-progress boundaries are unchanged.
- No persisted "failed" marker on `CompactionPart`; a failed compaction leaves no boundary, as before.
- Desktop changes (engine pin bump, e2e) ship separately.

## Tasks

- [ ] T1: Backstop cleanup in `SessionCompaction.process` — acceptance: a compaction step that fails, dies or is interrupted before writing the projection removes the boundary, leaves no unfinished summary message, re-raises the original exit, and `filterCompacted` no longer cuts at it; the five controlled rollback outcomes behave as before (covers: S2.1)
- [ ] T2: `/summarize` validates the model and reports failure — acceptance: an unknown request model answers 400 with no boundary written; a rollback answers a non-2xx `SessionCompactionFailedError`; a successful compaction still answers `true` (covers: S2.2, depends: T1)
- [ ] T3: Compaction runs on the boundary's model — acceptance: a session whose previous model no longer exists compacts successfully onto the requested model and writes a projection; an unchanged model still reuses the prefix snapshot (covers: S2.3)

## Journey log
