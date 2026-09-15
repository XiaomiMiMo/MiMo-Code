---
feature: synthetic-parts-persistence-cache
status: delivered
updated: 2026-09-16
branch: analyze/recall-unpersisted-push-cache
commits: e93a49cd97954df8cedbeff71d5f7230f6f8cc1d..f2108146437c8d0e36b1d0a1b30bbdd906b61085
---

# Synthetic Parts Unpersistence and Prompt-Cache Break

User selected **Option A** (persist + marker dedupe). Mid-turn `p.text` wrap stays request-only by design.

## Report

**What was built** — Unpersisted user-side synthetic injections in `session/prompt.ts` now follow the harness persist-once contract.

1. **Recall reminder** — `ensurePersistedUserSynthetic` + `RECALL_REMINDER_MARKER`; `hasMemoryOrTasks` only consulted when the marker is absent.
2. **Loop-streak nudge** — same helper + `LOOP_STREAK_REMINDER_MARKER` (replaces in-memory text check that never saw DB state).
3. **Compose prompt** — persist + marker; `position: "head"` keeps protocol first after DB reload (PartID order alone would append it after user text).
4. Exported pure helpers for unit tests: markers, `hasSyntheticReminder`, `buildRecallReminderText`, `buildLoopStreakReminderText`.

Multi-step runLoop reloads `msgs` from DB; marker hit skips re-push → last-user tail order stays stable across steps → provider prompt cache can reuse the prefix. Checkpoint-writer `ForkContext` capture (DB reload) now sees the same persisted parts as the parent request.

**Verification** —

| Command | Result |
|---------|--------|
| `bun typecheck` (filter: `src/session/prompt.ts`, `test/session/recall*`) | PASS — no errors in changed files |
| `bun test test/session/recall-reminder.test.ts test/session/recall-reminder-persist.test.ts test/session/plan-reminder-dedup.test.ts` | PASS — 14 pass / 0 fail / 45 expect |
| `bun test test/session/prompt-skill-command-multi.test.ts test/session/messages-pagination.test.ts` | PASS — 50 pass / 0 fail / 157 expect (run by orchestrator; review agent did not re-run) |

**Review residual (non-critical)** — Compose `position: "head"` is request-layer only. Parts reload `orderBy(PartTable.id)`; fork/checkpoint capture will still see `[user text, compose, …]` while parent runLoop requests `[compose, user, …]`. Main-loop prompt cache is stable; compose **fork** prefix parity is not fully closed. Recall/loop-streak (append + persist) achieve presence **and** PartID-order parity on DB reload.

**Journey log**

1. User screenshot line numbers `3840-3876` match **origin/main** at analysis time (`e93a49cd`), not the stale main checkout.
2. Bare `parts.push` is half the user-side reminder contract — `updatePart` + marker dedupe is the other half (auto-worktree / skills / plan).
3. Cache break was **order instability vs persisted `insertReminders` siblings** + **fork prefix DB reload**, not volatile recall text.
4. Compose needs `position: "head"` reorder after persist — ascending PartIDs alone put the protocol after user text on reload.
5. Mid-turn `p.text` wrap left request-only (intentional step≥2 steering); separate from Option A.

## [S1] Problem

`packages/opencode/src/session/prompt.ts` `runLoop` reloads history every step:

```ts
while (true) {
  let msgs = yield* MessageV2.filterCompactedEffect(sessionID, { ... })
  // ... inject synthetic content into msgs ...
  msgs = yield* insertReminders({ messages: msgs, agent, model, session })
  // ... serialize msgs into the LLM request ...
}
```

Several synthetic injections `parts.push(...)` (or `unshift`) **without** `sessions.updatePart(...)`. Injected bytes vanish on the next DB reload and reappear with a new `PartID` at a different index among later parts — mid-turn prompt-cache miss.

## [S2] Design (mechanism + chosen contract)

**Chosen contract (Option A):** every durable user-side synthetic reminder does `updatePart` once, then dedupes by stable marker substring on re-entry. Same pattern as auto-worktree / skill bodies / plan mode.

`ensurePersistedUserSynthetic` (`prompt.ts` ~1212):

- Marker present + `position: "head"` → move that part to index 0 (request-order stability).
- Marker present + append → no-op.
- Marker absent → `sessions.updatePart` then `push`/`unshift`.

Markers:

| Constant | Value | Site |
|----------|-------|------|
| `RECALL_REMINDER_MARKER` | `This session has memory at` | recall inject |
| `LOOP_STREAK_REMINDER_MARKER` | `repeating the same action without making progress` | loop-streak nudge |
| `COMPOSE_REMINDER_MARKER` | `MiMoCode Compose Agent` | compose protocol |

`toModelMessagesEffect` still includes non-ignored synthetic text; Desktop UI may hide `synthetic`. DB history now matches the request for these parts → trajectory / fork capture / history reload agree.

Mid-turn `p.text` wrap (`step > 1`) remains request-only: intentional steering that changes user text after the first finished assistant; not part of Option A.

## [S3] Out of Scope

- Mid-turn `p.text` wrap persistence/removal.
- Desktop-host L2 system injection (`pluginNote`, clocks).
- `prompt_cache_key` gateway routing.
- Filtering synthetic from trajectory serialization.

## [S4] Inventory (pre-fix → post-fix)

| Site | Before | After |
|------|--------|-------|
| Recall | bare push every step | persist + `RECALL_REMINDER_MARKER` |
| Loop-streak | bare push; in-memory dedupe | persist + `LOOP_STREAK_REMINDER_MARKER` |
| Compose | unpersisted unshift | persist + marker + head reorder |
| Crop / insertReminders / recovery users | already persisted | unchanged |
| Mid-turn wrap | request-only mutate | unchanged (out of scope) |

## [S5] Judgements

| Question | Judgement |
|----------|-----------|
| Inserted into user utterance middle? | No — user-side tail (compose head) synthetic part. |
| Belongs in system? | Policy stays in system; **path recall** stays user-side. Dynamic system content is a known prefix hazard. |
| Bare push a position bug? | Design chose user-side channel; implementation skipped persistence half. Fixed under Option A. |
| Trajectory side effects | Fixed for the three sites: DB and request now carry the same parts. |

## Tasks

- [x] T1: Decide strategy — **Option A** (user: 方案A)
- [x] T2: Align recall / loop-streak / compose to persist + marker — acceptance: no bare push; compose head stable after reload **on the runLoop request path** (covers: S2, S4)
- [x] T3: Regression tests — `recall-reminder.test.ts` (markers/helpers) + `recall-reminder-persist.test.ts` (exactly one recall part after multi-step turn) (covers: S2; depends: T2)
- [x] T4: Fork prefix parity — **presence** parity for recall/loop-stream via DB reload (parts visible to `tryStartCheckpointWriter`); **compose position** parity remains open (head is request-layer reorder) (covers: S2; depends: T2)

## Anchors (origin/main `e93a49cd` at analysis; delivered on feature branch)

| Symbol | File:line |
|--------|-----------|
| Markers + helpers | `packages/opencode/src/session/prompt.ts:177-213` |
| `ensurePersistedUserSynthetic` | `prompt.ts:1212-1239` |
| Compose inject | `prompt.ts:1258+` |
| Recall inject | `prompt.ts:3912-3936` |
| Loop-streak inject | `prompt.ts:4086-4112` |
| Mid-turn wrap (unchanged) | `prompt.ts` `step > 1` wrap |
| Tests | `test/session/recall-reminder.test.ts`, `test/session/recall-reminder-persist.test.ts` |

## Journey log

1. Analysis redone on origin/main `e93a49cd` after finding local main was 64 behind.
2. Persist + marker is the repo's own user-side reminder contract.
3. Cache break = order flip vs insertReminders + fork DB reload.
4. Compose needs explicit head reorder after persist.
5. Option A shipped; mid-turn wrap left request-only on purpose.
