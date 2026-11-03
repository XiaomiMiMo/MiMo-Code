# Cloud session sharing boundary

## Requirements

- R1 (both editions): the engine provides no cloud session sharing, automatic synchronization, unsharing, or share URL import. CLI, TUI, HTTP, GitHub integration and SDK expose no such operations.
- R2 (both editions): existing configuration and session databases remain readable. Old sharing settings and environment variables cannot enable uploads. Existing share records do not trigger synchronization or deletion requests.
- R3 (both editions): local JSON export/import, session creation, updates and deletion remain available. Desktop LAN sharing is owned by the desktop repository.

## Design

Session creation calls `Session.Service.create` directly. App and bootstrap runtimes have no sharing services or event subscriptions. The share transport is removed, including enterprise/account transport. CLI run and GitHub output contain no cloud links or social cards. TUI commands, shortcut declarations, tips and translations contain no sharing affordances. Import accepts local JSON files only and rejects URLs before bootstrap or network access. The v2 SDK is regenerated from actual OpenAPI; the v1 SDK loses share/unshare methods and operation types as well.

Configuration normalization discards `share` and `autoshare` before validation; TUI config normalization discards sharing shortcuts. Existing `session_share` schema is retained in the storage domain for JSON migration compatibility; existing `share_url` is inert session metadata. Published migrations are unchanged. Removing local capabilities does not revoke already published third-party links.

## Test points

| ID | Intent | Automation |
|----|--------|------------|
| TP-R14-01 | Real session routes work, removed cloud routes return 404, old auto configuration cannot send cloud requests. | `packages/cli/test/server/share-removed.test.ts` |
| TP-R14-02 | OpenAPI/SDK, CLI/TUI registrations and transport source contain no cloud operations; URL import makes no requests; legacy config remains usable. | `packages/cli/test/server/share-removed.test.ts`, `packages/cli/test/cli/share-removed.test.ts`, `packages/cli/test/config/config.test.ts` |

The corresponding desktop spec is `docs/specs/03-engine-routing/engine-runtime` in the desktop repository; real Electron regression lives in `tests/e2e/engine-runtime-shims.spec.ts` there.
