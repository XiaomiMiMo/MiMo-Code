---
feature: history-index-tool-output-budget
status: delivered
updated: 2026-11-03
source: fix/history-search-fetch-limit
---

# History FTS Index Budget (tool-output policy)

## Report

**What was built** — History FTS is truncated **before write** on the **same path as tool call results**: pure `previewToolOutput` in `tool/truncate.ts` is shared by `Truncate.output` and history `extract` / writer / import. Tool parts prefer the stored tool-result string (including `Full output saved to: <path>` when tools truncated); other kinds compose then preview with the same 50KiB / 2000-line budget. Full text stays in `PartTable` / tool-output files for `history get`. Migration v6 removes legacy chunk rows and rebuilds one truncated index row per original part. Search fetches exactly `limit` index rows ([S2.1]), with base-id dedupe kept as a guard.

**Verification** — `packages/cli`: `bun test test/history/` green after budget tests; `tsgo --noEmit` filtered to `src/history`/`test/history` clean. S2.1: `bun test --timeout 30000 test/history` 100 pass / 5 skip / 0 fail; `bun test test/tool/history.test.ts` 5 pass; `bun run typecheck` clean; the new `reads at most limit index rows` test fails on the previous `service.ts` (60 rows read) and passes after. `node:sqlite` benchmark on a real 47k-row index copy: `limit=50` went from 69–114ms to 8–27ms, `limit=10` from 13–36ms to 6–24ms; top-N part ids were identical before and after for all 14 query/limit pairs.

**Journey log**
- Root cause is **missing pre-write truncation**, not chunking: tool results are capped; history indexed full part payloads (`patch` ~38MB, `reasoning` ~600KB).
- User required the **tool-call-result path** — `previewToolOutput` extracted from `truncate.ts`; history writer/import call it before FTS insert.
- Chunk deletion uses exact base id plus the binary prefix range `[id + '#', id + '$')`, preserving literal `_`/`%` while using the primary-key index.
- Post-LIMIT dedupe under-filled search — over-fetch `limit*24` before dedupe. Superseded by [S2.1]: with one row per part, the over-fetch only cost main-thread time on Desktop.

## [S1] Problem

Tool outputs already have a staged length policy before entering the model (`truncate.output`: ≤50KiB / 2000 lines; full text saved to tool-output files). History FTS extract had **no equivalent budget** and indexed unbounded part payloads. On a real ~7.3GB trajectory DB this produced multi-MB FTS documents and CPU-heavy `snippet()+bm25()` ranking.

## [S2] Design

### Contracts

- Single write path `upsertHistoryBody`: **cleanDataUrls then previewToolOutput** before FTS insert (live writer, import, migration rebuild, test backfill)
- Pure preview lives in `tool/preview.ts` (no Log/Global); `tool/truncate.ts` re-exports and owns model-facing `Truncate.output`
- Extract also strips data-URLs before preview so binary payloads never consume the tool-result budget
- Budget: `MAX_BYTES=50KiB` / `MAX_LINES=2000` from `tool/preview.ts`, head+tail when tail looks like errors; index bodies hard-clamp to this ceiling
- Migration batch (`migration-batch.ts`) is Log-free; scheduler `startIndexMigration` accepts optional `migrate` for tests and clears `jobs` after 5 failed attempts
- Migration v6 SQL marks prior `history_index_migration` versions `done` so superseded state cannot linger at `clean`
- Search fetches exactly `limit` index rows — see [S2.1]
- Search uses `CROSS JOIN` so SQLite evaluates MATCH once, then rowid lookup (Node SQLite plan regression covered in tests)
- Tool body composition: `input` JSON previewed at ~25% budget; tool output previews keep the `Full output saved to:` path hint inside budget
- Migration scheduler: limited error backoff (5 attempts) + `jobs` slot clear on done/error/abort so restart works; `stopIndexMigration` deletes the slot
- `previewToolOutput` reserves `MARKER_RESERVE` bytes so omission markers stay within `MAX_BYTES`; single-line giant outputs keep a head slice instead of only the marker
- Tool parts: index stored tool-result string when present (incl. `Full output saved to: <path>`); still bound legacy payloads
- `history get` reads full `PartTable` text
- No new index chunks are written. Indexed deletion and search normalization only support legacy chunks during background cleanup.

### Background migration v6

- Always start `clean` → `repair`
- `clean`: delete legacy chunk rows and orphan index rows; never reconstruct text by joining old chunks.
- `repair`: read original parts, apply the shared truncate policy, and upsert exactly one row under the original part id. The 50KiB preview must not be split again at 48,000 characters.
- Recreate `history_part_ad` for chunk ids
- Separate the state insert, trigger drop, and trigger creation with Drizzle statement breakpoints so Node SQLite executes all three statements. `test/history/node-migration.test.ts` verifies deletion removes chunk rows while preserving unrelated parts through the actual Node driver.
- Startup waits one second before background work. Each transaction processes at most 32 rows and yields after an 8ms budget, checked between rows. Read one original body at a time; cursor and writes commit together, so yielding/restarting cannot skip unfinished rows.
- Rest after each batch for at least 100ms and at least 19 times its elapsed duration (including commit), targeting at most a 5% migration duty cycle per process. This is cooperative throttling, not a hard process CPU cap: an individual synchronous row or commit can exceed 8ms, and normal application work has a separate cost.
- The follow-up schema migration `20260916000000_history_single_row_index` replaces the delete trigger with the indexed prefix range and starts v6 even on databases that already completed v5; those databases can still contain chunks. V6 resumes its own persisted cursor on subsequent launches.
- Regression coverage: exact/chunk deletion preserves adjacent ids and literal wildcard characters; both deletion paths use an indexed query plan; both migration phases yield without losing cursor progress; the scheduler rests after work and cancels on database close.

### [S2.1] Search fetch limit (resolves debt `history-search-overfetch-after-v6`)

Desktop runs the engine on the Electron main thread, and search executes synchronously on it. The `limit*24` over-fetch read up to 1,200 bodies of ≤50KiB for `limit=50`; on a 47k-row index that cost 75–185ms per call, versus 15–40ms for `limit=10`.

- `fetchLimit = limit` unconditionally; no migration-state gate.
- Why unconditional is compatible with old data:
  - `history_fts.part_id` is the primary key, and `upsertHistoryBody` (the only writer) deletes every row of a part before writing one row under the base id. Current code cannot produce several rows per part.
  - Only legacy `part#N` chunk rows from v5 break that invariant. Each migration's `clean` phase (v6/v7/v8) deletes them.
  - v8 recreates `history_fts_idx` empty. Its SQL also recreates the triggers, so writes made before the first batch drops them are indexed, but those are all single base-id rows. Afterwards the index is refilled only in `finalize`, after `clean` has run. A migration-state gate would therefore buy nothing.
- Dedupe by `basePartId` stays as a guard. If residue survives (for example, an old v5 engine still writing to a shared DB), search may return fewer than `limit` hits but never duplicates.

## Follow-ups

- Search and other History reads still run synchronously on the engine thread; isolating them (worker or separate engine process) is tracked separately.

## [S3] Out of Scope

- `buildFtsQuery` AND/OR semantics
- Changing which part types are indexed
- Desktop `engine-pin` bump / shipping
- Online surgery of production DB outside the background migration

## Tasks

- [x] T1: `index-preview.ts` + `extract()` tool-output budget (covers: S2)
- [x] T2: `chunk-write.ts` shared upsert/delete; writer + import (covers: S2)
- [x] T3: `service.ts` search/get chunk-id normalize + over-fetch dedupe (covers: S2)
- [x] T4: Migration v6 + indexed trigger (covers: S2)
- [x] T5: Tests: index-preview, extract budgets, chunk-write, backfill (covers: S2)
- [x] T6: history unit suite + typecheck (covers: S2; depends: T1-T5)
- [x] T7: search `fetchLimit = limit`; drop the over-fetch comment — acceptance: a search with `limit: 5` over 60 matching parts reads at most 5 index rows; legacy chunk residue yields no duplicate hits (covers: S2.1)
- [x] T8: history suite + typecheck + Node-driver benchmark on a real-size index — acceptance: suite green; `limit=50` latency no longer pays for 1,200 rows (covers: S2.1; depends: T7)
