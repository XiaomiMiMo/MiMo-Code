---
feature: permission-skip-and-timeout-decouple
status: delivered
updated: 2026-04-02
branch: permission-skip-and-timeout-decouple
commits: 9d54ad3c..HEAD
---

# Permission Skip & Timeout Decouple

## Report

**What was built** — Split the monolithic `skipAll` boolean into two orthogonal runtime flags: `skipAll` (auto-allow normal permission asks) and `permissionAskTimeoutMs` (timeout for all human-confirmation asks). Added `/permission-timeout` TUI slash command with a modal selector (Never/30s/1min/2min/5min/10min), server API endpoints, and full i18n coverage across 7 languages.

**Verification** — All 147 permission tests pass (`bun test test/permission/` from `packages/opencode`). 5 new tests cover: env var compat, independent timeout (skip-all off), timeout on normal asks, null timeout (no timeout), skip-all+timeout combination.

**Journey log** — SDK regeneration (`./packages/sdk/js/script/build.ts`) is required when adding new server API endpoints; stale toast messages referencing old coupled behavior were found during review and fixed.

## [S1] Problem

The `skipAll` runtime toggle bundles two orthogonal concerns: (1) auto-allowing all normal permission asks, and (2) timing out forced-ask permissions (e.g. `bash_delete`). The timeout logic is hardcoded inside the skipAll branch of `ask()` (`permission/index.ts:489-510`), with duration controlled by the `MIMOCODE_SKIP_ALL_FORCED_ASK_TIMEOUT_MS` environment variable (default 60s).

This means:
- Users cannot enable ask-timeout without also skipping all normal permissions.
- Timeout duration is only configurable via environment variable — no TUI entry point.
- Two orthogonal concepts are coupled in a single boolean, increasing cognitive and maintenance cost.

## [S2] Design

### 2.1 Two independent toggles

Split into two instance-scoped runtime state fields:

| Toggle | Type | Semantics |
|--------|------|-----------|
| `skipAll` | `boolean` | Auto-allow all normal permission asks. Explicit deny rules still win. Forced-ask permissions still require human confirmation. Behavior unchanged. |
| `permissionAskTimeoutMs` | `number \| null` | Timeout in milliseconds for permission asks requiring human confirmation. `null` = no timeout (wait indefinitely). Positive integer = auto-reject after that duration. |

The two are orthogonal:
- `skipAll=true, timeout=null` — skip normal asks, forced-ask waits indefinitely (skip-all with timeout disabled).
- `skipAll=false, timeout=60000` — normal asks require confirmation, all asks auto-reject after 60s (new capability).
- `skipAll=true, timeout=60000` — original behavior (both enabled).
- `skipAll=false, timeout=null` — most conservative, all asks wait indefinitely (default).

### 2.2 Timeout scope

`permissionAskTimeoutMs` applies to all permission asks that reach the human-confirmation path (both normal and forced-ask), regardless of skipAll state. Timeout behavior:
1. Wait `permissionAskTimeoutMs` milliseconds.
2. On expiry, auto-reply `reject` (publish `Event.Replied`), fail the Deferred with `CorrectedError` carrying actionable feedback.
3. Clean up pending state.

### 2.3 Environment variable backward compat

`MIMOCODE_SKIP_ALL_FORCED_ASK_TIMEOUT_MS` maps to the initial `permissionAskTimeoutMs` value when set to a positive integer. When unset or 0, `permissionAskTimeoutMs` initializes to `null`.

### 2.4 Service interface change

```typescript
// New
readonly permissionAskTimeout: () => Effect.Effect<number | null>
readonly setPermissionAskTimeout: (ms: number | null) => Effect.Effect<void>
```

`skipAll` / `setSkipAll` unchanged.

### 2.5 ask() logic change

Replace the skipAll+forced timeout branch at `permission/index.ts:489-510` with generic timeout logic:

```
// When permissionAskTimeoutMs != null, wrap the entire await
// with Effect.timeoutOrElse.
// On timeout: publish reject + fail with CorrectedError.
```

The timeout no longer depends on `s.skipAll`; it depends solely on `s.permissionAskTimeoutMs`. Forced-ask and normal asks share the same timeout path.

### 2.6 TUI interaction

New `/permission-timeout` slash command opens a modal selector:

| Option | Value |
|--------|-------|
| Never | `null` |
| 30 seconds | `30000` |
| 1 minute | `60000` |
| 2 minutes | `120000` |
| 5 minutes | `300000` |
| 10 minutes | `600000` |

Selection calls `setPermissionAskTimeout` and shows a toast. The existing `/skip-permissions` command is unchanged (controls only `skipAll`).

### 2.7 Server API change

New HTTP endpoints:
- `GET /instance/permission/ask-timeout` — returns current `permissionAskTimeoutMs`
- `POST /instance/permission/ask-timeout` — body: `{ "ms": number | null }`, sets `permissionAskTimeoutMs`

Existing `setSkipAll` / `skipAll` endpoints unchanged.

### 2.8 i18n

New keys across all 7 languages (en/zh/zht/ru/ja/fr/es):
- `tui.command.permission_timeout.title`
- `tui.permission_timeout.title` / `hint` / `option.*` / `toast_*`

## [S3] Out of Scope

- `autoApproveDelete` mechanism (already an independent toggle).
- `--dangerously-skip-permissions` CLI flag behavior (injects allow-all via config ruleset, bypasses skipAll runtime toggle).
- `FORCED_ASK` permission set definition.
- Parent-grant inheritance or orchestrator-peer forward timeout logic (`FORWARD_DENY_TIMEOUT_MS` remains independent).
- Persisting `permissionAskTimeoutMs` to the database (runtime-only, same as skipAll).

## Tasks

- [x] T1: Service layer split — add `permissionAskTimeout` / `setPermissionAskTimeout` to Interface and State; generalize `ask()` timeout from `skipAll && forced` to `permissionAskTimeoutMs != null`. acceptance: unit tests cover 4 combinations (skipAll on/off × timeout on/off) (covers: S2.1, S2.2, S2.4, S2.5)
- [x] T2: Env var compat — `MIMOCODE_SKIP_ALL_FORCED_ASK_TIMEOUT_MS` maps to `permissionAskTimeoutMs` initial value. acceptance: new Instance's `permissionAskTimeout()` returns the env-derived value (covers: S2.3)
- [x] T3: Server API — add GET/POST `/instance/permission/ask-timeout` endpoints. acceptance: HTTP calls can read and write the timeout setting (covers: S2.7)
- [x] T4: TUI command — add `/permission-timeout` slash command with modal selector (Never/30s/1min/2min/5min/10min). acceptance: executing the command toggles the timeout and shows a toast (covers: S2.6)
- [x] T5: i18n — add translations for all 7 languages (en/zh/zht/ru/ja/fr/es). acceptance: labels display correctly when switching language (covers: S2.8)
- [x] T6: Test updates — update `skip-all-timeout.test.ts` for new behavior; add independent timeout tests (timeout works with skip-all off). acceptance: all permission tests pass (covers: S2.1, S2.2)
