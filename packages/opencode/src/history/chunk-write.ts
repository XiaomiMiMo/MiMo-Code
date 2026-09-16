import { and, eq, gte, lt, or } from "drizzle-orm"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import { HistoryFtsTable } from "./fts.sql"
import { basePartId } from "./chunk"
import { previewForIndex } from "./index-preview"

type DbLike = Pick<BaseSQLiteDatabase<"sync", unknown>, "select" | "insert" | "delete">

/** Binary prefix range uses the primary-key index; '_' and '%' remain literal. */
export function chunkRowFilter(partId: string) {
  const base = basePartId(partId)
  return or(
    eq(HistoryFtsTable.part_id, base),
    and(gte(HistoryFtsTable.part_id, base + "#"), lt(HistoryFtsTable.part_id, base + "$")),
  )!
}

export function deleteHistoryRows(db: DbLike, partId: string) {
  db.delete(HistoryFtsTable).where(chunkRowFilter(partId)).run()
}

/**
 * Single write path for history FTS. Always truncates via the tool-call-result
 * preview (`previewForIndex` → `previewToolOutput`) before insert — live writer,
 * import, migration rebuild, and backfill all land here.
 */
export function upsertHistoryBody(
  db: DbLike,
  input: {
    part_id: string
    session_id: string
    message_id: string
    project_id: string
    tool_name: string | null
    body: string
    time_created: number
  },
) {
  const base = basePartId(input.part_id)
  deleteHistoryRows(db, base)
  // Single gate: clean + tool-result preview (shared with extract).
  const data = {
    ...input,
    part_id: base,
    body: previewForIndex(input.body),
  }
  db.insert(HistoryFtsTable).values(data).onConflictDoUpdate({ target: HistoryFtsTable.part_id, set: data }).run()
}
