import { and, asc, eq, gt, lte, sql } from "drizzle-orm"
import type { Database } from "../storage"
import type { PartID } from "../session/schema"
import { PartTable, SessionTable } from "../session/session.sql"
import { HistoryFtsTable, HistoryIndexMigrationTable as State } from "./fts.sql"
import { indexImportedParts } from "./import"
import { basePartId, CHUNK_BODY_MAX } from "./chunk"
import { deleteHistoryRows, upsertHistoryBody } from "./chunk-write"
import { extract } from "./extract"
import { previewToolOutput } from "../tool/truncate"
import { Log } from "../util"

const log = Log.create({ service: "history.migration" })
/** v5: re-chunk oversized FTS bodies + drop orphans; then re-index from parts. */
const version = 5
const batch = 128
const jobs = new WeakMap<ReturnType<typeof Database.Client>, AbortController>()

/** One bounded, atomic batch. Other processes reread the cursor under the lock. */
export function migrateIndexBatch(db: ReturnType<typeof Database.Client>) {
  return db.transaction(
    (tx) => {
      const state = tx.select().from(State).where(eq(State.version, version)).get()
      if (!state || state.phase === "done") return false
      if (state.phase === "clean") {
        const rowid = sql<number>`history_fts.rowid`
        const rows = tx
          .select({ rowid, id: HistoryFtsTable.part_id, body: HistoryFtsTable.body })
          .from(HistoryFtsTable)
          .where(gt(rowid, state.cursor))
          .orderBy(asc(rowid))
          .limit(batch)
          .all()
        for (const row of rows) {
          const base = basePartId(row.id)
          const partRow = tx
            .select({
              id: PartTable.id,
              session_id: PartTable.session_id,
              message_id: PartTable.message_id,
              data: PartTable.data,
              time_created: PartTable.time_created,
              project_id: SessionTable.project_id,
            })
            .from(PartTable)
            .innerJoin(SessionTable, eq(SessionTable.id, PartTable.session_id))
            .where(eq(PartTable.id, base as PartID))
            .get()
          if (!partRow) {
            deleteHistoryRows(tx, base)
            continue
          }
          const oversized = row.body.length > CHUNK_BODY_MAX
          const alreadyChunked = base !== row.id
          if (!oversized && !alreadyChunked) continue
          const extracted = extract({
            ...partRow.data,
            id: partRow.id,
            messageID: partRow.message_id,
            sessionID: partRow.session_id,
          } as never)
          if (!extracted) {
            deleteHistoryRows(tx, base)
            continue
          }
          upsertHistoryBody(tx, {
            part_id: base,
            session_id: partRow.session_id,
            message_id: partRow.message_id,
            project_id: partRow.project_id,
            tool_name: extracted.tool_name,
            // Rebuild path also truncates — same tool-result preview path.
            body: previewToolOutput(extracted.body).content,
            time_created: partRow.time_created,
          })
        }
        if (!rows.length) {
          tx.update(State).set({ phase: "repair", cursor: 0 }).where(eq(State.version, version)).run()
          return true
        }
        const nextCursor = rows.at(-1)!.rowid
        tx.update(State).set({ cursor: nextCursor }).where(eq(State.version, version)).run()
        if (state.fts_end > 0 && nextCursor >= state.fts_end) {
          tx.update(State).set({ phase: "repair", cursor: 0 }).where(eq(State.version, version)).run()
        }
        return true
      }
      const rowid = sql<number>`part.rowid`
      const rows = tx
        .select({ rowid, id: PartTable.id })
        .from(PartTable)
        .where(and(gt(rowid, state.cursor), lte(rowid, state.part_end)))
        .orderBy(asc(rowid))
        .limit(batch)
        .all()
      indexImportedParts(
        tx,
        rows.map((row) => row.id),
      )
      tx.update(State)
        .set(rows.length ? { cursor: rows.at(-1)!.rowid } : { phase: "done" })
        .where(eq(State.version, version))
        .run()
      return rows.length > 0
    },
    { behavior: "immediate" },
  )
}

export function startIndexMigration(db: ReturnType<typeof Database.Client>) {
  if (jobs.has(db)) return
  const abort = new AbortController()
  jobs.set(db, abort)
  try {
    const state = db.select().from(State).where(eq(State.version, version)).get()
    if (state?.phase === "done") return
  } catch (error) {
    log.warn("index migration unavailable", { error: String(error) })
    return
  }
  const run = () => {
    if (abort.signal.aborted) return
    try {
      if (migrateIndexBatch(db)) setTimeout(run, 10).unref()
    } catch (error) {
      log.warn("index migration paused", { error: String(error) })
    }
  }
  setTimeout(run, 0).unref()
}

export function stopIndexMigration(db: ReturnType<typeof Database.Client>) {
  jobs.get(db)?.abort()
}

export const MIGRATION_VERSION = version
