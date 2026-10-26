---
feature: cron-session-affinity
status: delivered
updated: 2026-10-12
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2648
---

# Cron Session Affinity

## Report

**What was built** — Scheduled `cron` / `loop` prompts now fire into the session that created the job instead of whichever session first started the process-wide CronBridge. `onFire` resolves the inject target via `fireTargetSessionId(task, bridgeSession)`; `createdBySessionId` is stamped on `armLoop` and inherited across keepalive re-arms so a loop owned by session B keeps its stamp even when the bridge is mounted on A. `get` / `delete` / `rename` / `list` share one ownership rule: hide only tasks stamped to another session; legacy unmarked rows stay visible and fire into the current bridge session. Empty-string stamps count as unmarked everywhere.

**Verification** — `bun test packages/cli/test/cron packages/cli/test/tool/cron.test.ts packages/cli/test/session/cron-bridge.integration.test.ts` → 79 pass / 0 fail. `bun run typecheck` → PASS. Lint on touched files: 0 errors (warnings pre-existing). Review 1 of `3c6e6bb0..bfdb2b17` found CRITICAL (keepalive `armLoop` dropped the owner stamp) → fixed in `082b8124`. Review 2 of the PR found CRITICAL on the post-fire path (one-shot loop row removed after fire, so inherit-from-prior found nothing) → fixed in `4c3a7e46` by persisting the owner on `LoopState`. Re-review of `4c3a7e46` → APPROVE, no remaining criticals.

**Journey log** —
1. User guess "cron never marks the session" was only half-right: `createdBySessionId` existed on `schedule` but was ignored at fire time and never written by `armLoop`.
2. `loop` is not a standalone tool: `/loop` is a skill wrapping `cron schedule`; `cron` also has a `loop` action (`armLoop`). Both shared the wrong-session fire path.
3. Desktop EngineInstanceStore already accepts cron into non-active sessions by design (R2/R9); the bug was engine-side routing, not desktop mis-attribution. Sidebar lag for a never-listed session (30s poll) is a UI-discovery gap, out of scope.
4. Keepalive affinity needed two layers: inherit-from-prior covers supersession of a live row; `LoopState.createdBySessionId` covers the post-fire path where the one-shot row is already gone. Persist owner on the longer-lived state object.
5. e2e `fireToInject` mirrors production `onFire` rather than invoking it (AppRuntime dynamic-import seam); helper-level tests cover the contract, not the live callback wiring.

## [S1] Problem

Users (notably from mimo-desktop multi-session hosts) report that scheduled
`cron` / `loop` prompts fire into the wrong session. Code confirmed this:

- `CronBridge.onFire` always injected into `handle.sessionID` (the first session
  that called `start`) and never read `task.createdBySessionId`.
- `CronBridge` is a single-slot singleton; a second session's `start` is a no-op,
  so every fire in the process landed on the first session.
- `scheduler.armLoop` never wrote `createdBySessionId`, so loop tasks had no
  owner stamp at all (and keepalive re-arm dropped any stamp).
- `get` / `delete` / `rename` only applied a session filter when the caller
  explicitly passed `session_id`; the tool schema claims "defaults to current
  session" but did not enforce it.
- `LoopState` is a process-global map keyed by prompt text only.

## [S2] Design

### Fire routing

When a task fires, inject into the task's owning session:

1. Target session = `task.createdBySessionId` when present (truthy).
2. Legacy / unmarked tasks (no stamp, or empty-string stamp) fall back to the
   current bridge session (previous behavior) so existing durable jobs keep firing.

`injectScheduledPrompt` already accepts an explicit `sessionID`; `onFire` passes
the target session rather than `handle.sessionID`. Sentinel expansion
(`resolveAtFireTime`) uses the bridge's `workspaceRoot` and the **target**
session id so the cache is keyed per receiving session.

### Session stamping

- `scheduler.add` stamps `createdBySessionId` when `input.session_id` is set.
- `armLoop` accepts and stamps `session_id`. Owner resolution is truthiness
  (`""` = unmarked): explicit `session_id`, else a stamped prior same-prompt
  loop task, else `LoopState.createdBySessionId`. `LoopState` outlives the
  one-shot task (which the tick removes after fire), so post-fire keepalive
  re-arms still stamp the creating session.
- The cron tool's `loop` action passes `sessionID` (resolved like `schedule`).

### Ownership on read/update/delete

- `CronTool` always passes `session_id: sessionID` (resolved from
  `op.session_id || ctx.sessionID`) to `get` / `delete` / `rename`, matching
  `list` / `schedule`.
- `findById` ownership check: when a session filter is supplied, a task with a
  different `createdBySessionId` is not visible. A task with **no**
  `createdBySessionId` stays visible (legacy tolerance), matching the fire-time
  fallback. When no filter is supplied (internal callers), behavior is
  unchanged.
- `list` uses the same rule (hide only tasks stamped to another session) so
  legacy unmarked rows remain discoverable and cancellable.
- Empty-string stamps are treated as unmarked across fire/list/findById.

### Loop state

`armLoop` stamps the task and stores the owner on `LoopState.createdBySessionId`
so affinity survives post-fire removal of the one-shot loop row. `LoopState`
remains keyed by prompt for this iteration (keepalive and max-age). Full
per-session LoopState isolation is out of scope; see S3.

### Desktop (mimo-desktop) alignment

EngineInstanceStore is a passive mirror: `apply()` accepts `message.*` /
`session.status` for any sessionID without requiring the session to be the
selected/active one. `engineAwareActivity` lights the sidebar spinner from
`sessionStatus[type≠idle]`. `refreshActivity` (2s) hydrates non-idle sessions;
`loadEngineSessions` (30s / window focus) rebuilds the convo list from the
engine session list. So a fire into a cold (unselected) session is intentional
and correctly attributed after this fix — the creating conversation is the one
that goes busy. Remaining desktop-side lag (a session not yet in `convos` may
take up to 30s to appear in the sidebar) is a UI-discovery gap, not a
correctness bug, and is out of scope here.

### Error / edge behavior

- Target session id present but the session is gone: `injectScheduledPrompt`
  already fails into the existing log path; no new recovery.
- Same-tick double-fire latch and lock ownership stay unchanged.
- Non-owner processes still only fire session-store tasks; durable file tasks
  remain lock-owner-only.

## [S3] Out of Scope

- Multi-slot CronBridge / per-session keepalive sweeps.
- Per-session `isLoading` gating (busy of one session still delays the whole
  tick).
- Re-keying `LoopState` by (session, prompt).
- Migrating or deleting legacy unmarked durable tasks.
- Desktop UI / Automations page changes; 30s sidebar discovery lag.

## Tasks
- [x] T1: Route `onFire` through `task.createdBySessionId` with fallback to bridge session — acceptance: a task stamped with session B injects into B while the bridge is mounted on A (covers: S2)
- [x] T2: Stamp `createdBySessionId` in `armLoop` and pass `session_id` from the cron tool `loop` action — acceptance: created loop task has `createdBySessionId` equal to the calling session (covers: S2; depends: T1)
- [x] T3: Always pass resolved `sessionID` into `get`/`delete`/`rename` in CronTool — acceptance: get/delete/rename from session A cannot act on a task stamped to session B (covers: S2; depends: T1)
- [x] T4: Regression tests for cross-session fire routing, loop stamping, and ownership filter — acceptance: tests fail before the fix and pass after (covers: S2; depends: T1, T2, T3)
