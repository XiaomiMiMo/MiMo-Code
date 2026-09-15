---
feature: history-index-tool-output-budget
status: delivered
updated: 2026-09-16
branch: feat/history-chunk-large-bodies
commits: b4cc11cd652195af9a80297ed543218f3172e6c4..<worktree-uncommitted>
---

# History FTS Index Budget (tool-output policy)

## Report

**What was built** — History FTS is truncated **before write** on the **same path as tool call results**: pure `previewToolOutput` in `tool/truncate.ts` is shared by `Truncate.output` and history `extract` / writer / import. Tool parts prefer the stored tool-result string (including `Full output saved to: <path>` when tools truncated); other kinds compose then preview with the same 50KiB / 2000-line budget. Full text stays in `PartTable` / tool-output files for `history get`. Migration v6 removes legacy chunk rows and rebuilds one truncated index row per original part.

**Verification** — `packages/opencode`: `bun test test/history/` green after budget tests; `tsgo --noEmit` filtered to `src/history`/`test/history` clean.

**Journey log**
- Root cause is **missing pre-write truncation**, not chunking: tool results are capped; history indexed full part payloads (`patch` ~38MB, `reasoning` ~600KB).
- User required the **tool-call-result path** — `previewToolOutput` extracted from `truncate.ts`; history writer/import call it before FTS insert.
- Chunk deletion uses exact base id plus the binary prefix range `[id + '#', id + '$')`, preserving literal `_`/`%` while using the primary-key index.
- Post-LIMIT dedupe under-filled search — over-fetch `limit*24` before dedupe.

## [S1] Problem

Tool outputs already have a staged length policy before entering the model (`truncate.output`: ≤50KiB / 2000 lines; full text saved to tool-output files). History FTS extract had **no equivalent budget** and indexed unbounded part payloads. On a real ~7.3GB trajectory DB this produced multi-MB FTS documents and CPU-heavy `snippet()+bm25()` ranking.

## [S2] Design

### Contracts

- Single write path `upsertHistoryBody`: **always** `previewToolOutput(body)` before FTS insert (live writer, import, migration rebuild, test backfill)
- Budget: `MAX_BYTES=50KiB` / `MAX_LINES=2000` from `tool/truncate.ts`, head+tail when tail looks like errors
- Tool parts: index stored tool-result string when present (incl. `Full output saved to: <path>`); still bound legacy payloads
- Other parts: compose then preview; rebuild/migration also preview before write
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
