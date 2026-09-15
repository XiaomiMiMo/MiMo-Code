import { eq, or, sql } from "drizzle-orm"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import { HistoryFtsTable } from "./fts.sql"
import { cleanDataUrls } from "./media"
import { basePartId, chunkBody, chunkId } from "./chunk"
import { previewToolOutput } from "../tool/truncate"

type DbLike = Pick<BaseSQLiteDatabase<"sync", unknown>, "select" | "insert" | "delete">

/** Match the bare part id or any `${id}#<n>` chunk without LIKE ESCAPE (part ids contain `_`). */
export function chunkRowFilter(partId: string) {
  const base = basePartId(partId)
  return or(
    eq(HistoryFtsTable.part_id, base),
    sql`substr(${HistoryFtsTable.part_id}, 1, ${base.length + 1}) = ${base + "#"}`,
  )!
}

export function deleteHistoryRows(db: DbLike, partId: string) {
  db.delete(HistoryFtsTable).where(chunkRowFilter(partId)).run()
}

/**
 * Single write path for history FTS. Always truncates via the tool-call-result
 * preview (`previewToolOutput`) before insert — live writer, import, migration
 * rebuild, and backfill all land here.
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
  // Rebuild/migration/live write 兜底: same truncation path as tool call results.
  const bounded = previewToolOutput(input.body).content
  const chunks = chunkBody(bounded)
  for (let i = 0; i < chunks.length; i++) {
    const body = cleanDataUrls(chunks[i]!, undefined, "index")
    const data = {
      part_id: chunkId(base, i, chunks.length),
      session_id: input.session_id,
      message_id: input.message_id,
      project_id: input.project_id,
      tool_name: input.tool_name,
      body,
      time_created: input.time_created,
    }
    db.insert(HistoryFtsTable).values(data).onConflictDoUpdate({ target: HistoryFtsTable.part_id, set: data }).run()
  }
}
