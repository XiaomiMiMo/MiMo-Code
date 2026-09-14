import { and, asc, eq, gt, lte, sql } from "drizzle-orm"
import type { Database } from "../storage"
import { PartTable } from "../session/session.sql"
import { HistoryFtsTable, HistoryIndexMigrationTable as State } from "./fts.sql"
import { cleanDataUrls } from "./media"
import { indexImportedParts } from "./import"
import { Log } from "../util"

const log = Log.create({ service: "history.migration" })
const version = 2
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
          .where(and(gt(rowid, state.cursor), lte(rowid, state.fts_end)))
          .orderBy(asc(rowid))
          .limit(batch)
          .all()
        for (const row of rows) {
          const body = cleanDataUrls(row.body, undefined, "index")
          if (body !== row.body)
            tx.update(HistoryFtsTable).set({ body }).where(eq(HistoryFtsTable.part_id, row.id)).run()
        }
        tx.update(State)
          .set(rows.length ? { cursor: rows.at(-1)!.rowid } : { phase: "repair", cursor: 0 })
          .where(eq(State.version, version))
          .run()
        return true
      }
      const rowid = sql<number>`part.rowid`
      // Bound visited rows as well as writes, even if most parts are already indexed.
      const rows = tx
        .select({ rowid, id: PartTable.id, indexed: HistoryFtsTable.part_id })
        .from(PartTable)
        .leftJoin(HistoryFtsTable, eq(HistoryFtsTable.part_id, PartTable.id))
        .where(and(gt(rowid, state.cursor), lte(rowid, state.part_end)))
        .orderBy(asc(rowid))
        .limit(batch)
        .all()
      indexImportedParts(
        tx,
        rows.filter((row) => row.indexed === null).map((row) => row.id),
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
  if (db.select().from(State).where(eq(State.version, version)).get()?.phase === "done") return
  const run = () => {
    if (abort.signal.aborted) return
    try {
      if (migrateIndexBatch(db)) setTimeout(run, 10).unref()
    } catch (error) {
      // The failed batch rolled back. Resume its durable cursor on next open.
      log.warn("index migration paused", { error: String(error) })
    }
  }
  setTimeout(run, 0).unref()
}

export function stopIndexMigration(db: ReturnType<typeof Database.Client>) {
  jobs.get(db)?.abort()
}
