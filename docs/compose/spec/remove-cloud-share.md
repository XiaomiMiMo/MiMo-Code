# Cloud session sharing removal

## Requirements

- R1 (both editions): the engine provides no cloud session sharing, automatic synchronization, unsharing, or share URL import. CLI, TUI, HTTP, GitHub integration, plugin API and SDK expose no such operations or fields.
- R2 (both editions): existing configuration and session databases remain usable, including by older clients that share the same database. Old sharing settings and environment variables cannot enable uploads. Existing share records and share links are cleared from the local database.
- R3 (both editions): local JSON export/import, session creation, updates and deletion remain available. Desktop LAN sharing is owned by the desktop repository.

## Design

Session creation calls `Session.Service.create` directly. App and bootstrap runtimes have no sharing services or event subscriptions. The share transport is removed, including enterprise/account transport. CLI run and GitHub output contain no cloud links or social cards. TUI commands, shortcut declarations, tips and translations contain no sharing affordances. Import accepts local JSON files only and rejects URLs before bootstrap or network access. The v2 SDK is regenerated from actual OpenAPI; the v1 SDK loses share/unshare methods, operation types and the session `share` field as well.

`Session.Info` has no `share` field, so session reads, `session.updated` events and the OpenAPI `Session` schema carry no share link. Replaying older `session.updated` events that still contain `share` is safe: the session projection writes only known columns and ignores it. The `sidebar_title` plugin slot no longer receives `share_url`. The bundled `mimocode-docs` reference lists no sharing commands or settings.

All release channels share one `mimocode.db`, so an older client may open the database this engine migrated. Migration `20261103000000_remove_session_share` therefore clears the data instead of dropping the schema: it sets `session.share_url` to NULL and deletes every `session_share` row. Dropping them would break older clients: their session inserts fail on the missing column, and their share sync queries `session_share` on every update. The engine itself neither declares nor reads the column or the table, so it also works on databases where an earlier draft of this migration had already dropped them. The migration keeps its directory name because drizzle tracks applied migrations by name: those databases skip it instead of updating a missing column. Published migrations are unchanged. JSON storage migration ignores legacy `session_share/*.json` files and session `share` links; OpenCode database import ignores the source `share_url` column.

Configuration normalization discards `share`, `autoshare` and `enterprise` (whose `url` only the removed transport read) before validation, and the config schema no longer declares them; TUI config normalization discards sharing shortcuts. Removing local capabilities and data does not revoke already published third-party links.

## Test points

| ID | Intent | Automation |
|----|--------|------------|
| TP-R14-01 | Real session routes work, removed cloud routes return 404, old auto configuration cannot send cloud requests, created sessions carry no share field. | `packages/cli/test/server/share-removed.test.ts` |
| TP-R14-02 | OpenAPI/SDK and CLI registrations contain no cloud operations or session share field; URL import makes no requests; legacy config remains usable. | `packages/cli/test/server/share-removed.test.ts`, `packages/cli/test/cli/share-removed.test.ts`, `packages/cli/test/config/config.test.ts`, `packages/cli/test/config/tui.test.ts` |
| TP-R14-03 | The migration clears existing share records and links while keeping the schema older clients use; JSON and OpenCode imports drop legacy share data; legacy share events still replay; databases migrated by the dropping draft still start. | `packages/cli/test/storage/remove-session-share.test.ts`, `packages/cli/test/storage/json-migration.test.ts`, `packages/cli/test/session/opencode-import-safety.test.ts`, `packages/cli/test/session/share-replay.test.ts` |

The corresponding desktop spec is `docs/specs/03-engine-routing/engine-runtime` in the desktop repository; real Electron regression lives in `tests/e2e/engine-runtime-shims.spec.ts` there.
