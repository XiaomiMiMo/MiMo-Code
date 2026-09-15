---
feature: history-index-tool-output-budget
status: delivered
updated: 2026-09-15
branch: feat/history-chunk-large-bodies
commits: b4cc11cd652195af9a80297ed543218f3172e6c4..<worktree-uncommitted>
---

# History FTS Index Budget (tool-output policy)

## Report

**What was built** — History FTS is truncated **before write** on the **same path as tool call results**: pure `previewToolOutput` in `tool/truncate.ts` is shared by `Truncate.output` and history `extract` / writer / import. Tool parts prefer the stored tool-result string (including `Full output saved to: <path>` when tools truncated); other kinds compose then preview with the same 50KiB / 2000-line budget. Full text stays in `PartTable` / tool-output files for `history get`. Migration v5 re-extracts with that shared policy.

**Verification** — `packages/opencode`: `bun test test/history/` green after budget tests; `tsgo --noEmit` filtered to `src/history`/`test/history` clean.

**Journey log**
- Root cause is **missing pre-write truncation**, not chunking: tool results are capped; history indexed full part payloads (`patch` ~38MB, `reasoning` ~600KB).
- User required the **tool-call-result path** — `previewToolOutput` extracted from `truncate.ts`; history writer/import call it before FTS insert.
- LIKE ESCAPE failed on part ids containing `_`; delete uses `substr(part_id,1,len+1)=id||'#'`.
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
- Chunk delete/trigger + search over-fetch/dedupe remain for index hygiene

### Migration v5

- Always start `clean` → `repair`
- `clean`: drop orphan FTS rows; re-extract oversized bodies (now budgeted)
- `repair`: re-index all parts via shared upsert
- Recreate `history_part_ad` for chunk ids

## [S3] Out of Scope

- `buildFtsQuery` AND/OR semantics
- Changing which part types are indexed
- Desktop `engine-pin` bump / shipping
- Online surgery of production DB outside v5 migration

## Tasks

- [x] T1: `index-preview.ts` + `extract()` tool-output budget (covers: S2)
- [x] T2: `chunk-write.ts` shared upsert/delete; writer + import (covers: S2)
- [x] T3: `service.ts` search/get chunk-id normalize + over-fetch dedupe (covers: S2)
- [x] T4: Migration v5 + trigger (covers: S2)
- [x] T5: Tests: index-preview, extract budgets, chunk-write, backfill (covers: S2)
- [x] T6: history unit suite + typecheck (covers: S2; depends: T1-T5)
