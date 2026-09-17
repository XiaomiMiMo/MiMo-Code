---
feature: synthetic-parts-persistence-cache
status: delivered
updated: 2026-09-16
branch: analyze/recall-unpersisted-push-cache
commits: b4cc11cd652195af9a80297ed543218f3172e6c4..73003a620907031d67de979ce357310e10441223
---

# Synthetic Parts Unpersistence and Prompt-Cache Break

User selected **Option A** (persist + marker dedupe). Mid-turn `p.text` wrap stays request-only by design.

## Report

**What was built** — Unpersisted user-side synthetic injections in `session/prompt.ts` now follow the harness persist-once contract.

1. **Recall reminder** — `ensurePersistedUserSynthetic` + `RECALL_REMINDER_MARKER`; `hasMemoryOrTasks` only consulted when the marker is absent.
2. **Loop-streak nudge** — same helper + `LOOP_STREAK_REMINDER_MARKER`.
3. **Compose prompt** — persist + `COMPOSE_REMINDER_MARKER`; durable order via `MessageV2.promoteComposeProtocolFirst` on hydrate/parts load (shared by runLoop, fork capture, trajectory). In-memory `position: "head"` only aligns the same request before the first reload.
4. Exported pure helpers: markers, `hasSyntheticReminder`, `buildRecallReminderText`, `buildLoopStreakReminderText`; `COMPOSE_REMINDER_MARKER` owned by `message-v2.ts`, re-exported from `prompt.ts` for tests.

Multi-step runLoop reloads `msgs` from DB; marker hit skips re-push → last-user tail order stays stable. Compose head is a **load-time invariant** (not a per-request compensating projection), so checkpoint-writer `ForkContext` matches the parent request prefix.

**Verification** —

| Command | Result |
|---------|--------|
| `bun typecheck` (filter: `src/session/prompt.ts`, `src/session/message-v2.ts`, `test/session/recall*`) | PASS — no errors in changed files |
| `bun test --timeout 20000 test/session/recall-reminder.test.ts test/session/recall-reminder-persist.test.ts test/session/plan-reminder-dedup.test.ts test/session/prompt-skill-command-multi.test.ts test/session/messages-pagination.test.ts test/session/message-v2.test.ts test/session/compose-reminder-persist.test.ts` | PASS |
| scope note | Engine persist/marker + hydrate-order invariant; no UI surface. Unit/integration receipts above are the DoD. |

**Review residual (closed after CR r1)** — Compose head was request-layer only. CR r1 marked that ⚠️. Fix: `MessageV2.promoteComposeProtocolFirst` runs on every hydrate/load (`hydrate` + `parts()`), so runLoop, checkpoint fork capture, and trajectory all see `[compose, user, …]`. DB storage remains PartID-asc; position is a **load-time invariant**, not a per-request compensating projection.

**Journey log**

1. User screenshot line numbers `3840-3876` match **origin/main** at analysis time (`e93a49cd`), not the stale main checkout.
2. Bare `parts.push` is half the user-side reminder contract — `updatePart` + marker dedupe is the other half (skills / plan).
3. Cache break was **order instability vs persisted `insertReminders` siblings** + **fork prefix DB reload**, not volatile recall text.
4. Compose head is closed by `promoteComposeProtocolFirst` at the MessageV2 load boundary — not by request-layer-only reorder.
5. Mid-turn `p.text` wrap left request-only (intentional step≥2 steering); separate from Option A.
6. History search (`history/service.ts` PartTable projection) does not promote compose order — non-LLM summary path, accepted boundary.

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

**Chosen contract (Option A):** every durable user-side synthetic reminder does `updatePart` once, then dedupes by stable marker substring on re-entry. Same pattern as skill bodies / plan mode.

`ensurePersistedUserSynthetic` (`prompt.ts` ~1213):

- Marker present + `position: "head"` → `promoteComposeProtocolFirst` on the in-memory parts array.
- Marker present + append → no-op.
- Marker absent → `sessions.updatePart`, `push`, then optional promote for head.

`MessageV2.promoteComposeProtocolFirst` (`message-v2.ts` ~735): load-time compose-first invariant applied in `hydrate` and `parts()`. Mutates the parts array in place; DB remains PartID-asc.

Markers:

| Constant | Value | Owner |
|----------|-------|-------|
| `RECALL_REMINDER_MARKER` | `This session has memory at` | `prompt.ts` |
| `LOOP_STREAK_REMINDER_MARKER` | `repeating the same action without making progress` | `prompt.ts` |
| `COMPOSE_REMINDER_MARKER` | `MiMoCode Compose Agent` | `message-v2.ts` (re-export from `prompt.ts`) |

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
| Compose | unpersisted unshift | persist + marker + hydrate promote to head |
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
- [x] T4: Fork prefix parity — presence via persist; compose position via `promoteComposeProtocolFirst` on hydrate/parts load (covers: S2; depends: T2)
- [x] T5: CR r1 — promoteComposeProtocolFirst + unit tests; no UI e2e (engine-only invariant); spec commits base `b4cc11cd` (covers: S2, S4)

## Anchors (base `b4cc11cd`; delivered on feature branch)

| Symbol | File |
|--------|------|
| Markers + helpers | `packages/opencode/src/session/prompt.ts` (`RECALL_…`, `LOOP_STREAK_…`, re-export `COMPOSE_…`) |
| `COMPOSE_REMINDER_MARKER` + `promoteComposeProtocolFirst` | `packages/opencode/src/session/message-v2.ts` |
| `ensurePersistedUserSynthetic` | `packages/opencode/src/session/prompt.ts` (same file, ~1213) |
| Compose / recall / loop-streak inject | `prompt.ts` `insertReminders` + runLoop |
| Mid-turn wrap (unchanged, S3) | `prompt.ts` `step > 1` wrap |
| Tests | `test/session/recall-reminder.test.ts`, `test/session/recall-reminder-persist.test.ts` |
| History non-promote boundary | `packages/opencode/src/history/service.ts` comment near part assembly |

## Journey log

1. Analysis redone on origin/main `e93a49cd` after finding local main was 64 behind.
2. Persist + marker is the repo's own user-side reminder contract.
3. Cache break = order flip vs insertReminders + fork DB reload.
4. Compose needs explicit head reorder after persist.
5. Option A shipped; mid-turn wrap left request-only on purpose.
