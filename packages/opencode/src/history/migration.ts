import { and, asc, eq, gt, lte, sql } from "drizzle-orm"
import type { Database } from "../storage"
import type { PartID } from "../session/schema"
import { PartTable } from "../session/session.sql"
import { HistoryFtsTable, HistoryIndexMigrationTable as State } from "./fts.sql"
import { indexImportedParts } from "./import"
import { basePartId } from "./chunk"
import { deleteHistoryRows } from "./chunk-write"
import { Log } from "../util"

const log = Log.create({ service: "history.migration" })
/** v6: drop legacy chunks/orphans; rebuild one truncated index row per part. */
const version = 6
const batch = 32
const budgetMs = 8
const jobs = new WeakMap<ReturnType<typeof Database.Client>, AbortController>()

/** One bounded, atomic batch. Other processes reread the cursor under the lock. */
export function migrateIndexBatch(db: ReturnType<typeof Database.Client>) {
  const started = performance.now()
  return db.transaction(
    (tx) => {
      const state = tx.select().from(State).where(eq(State.version, version)).get()
      if (!state || state.phase === "done") return false
      if (state.phase === "clean") {
        const rowid = sql<number>`history_fts.rowid`
        const rows = tx
          .select({ rowid, id: HistoryFtsTable.part_id })
          .from(HistoryFtsTable)
          .where(and(gt(rowid, state.cursor), lte(rowid, state.fts_end)))
          .orderBy(asc(rowid))
          .limit(batch)
          .all()
        let cursor = state.cursor
        for (const row of rows) {
          if (cursor !== state.cursor && performance.now() - started >= budgetMs) break
          cursor = row.rowid
          const base = basePartId(row.id)
          if (base !== row.id) {
            deleteHistoryRows(tx, base)
            continue
          }
          const part = tx.select({ id: PartTable.id }).from(PartTable)
            .where(eq(PartTable.id, base as PartID)).get()
          if (!part) deleteHistoryRows(tx, base)
        }
        if (!rows.length) {
          tx.update(State).set({ phase: "repair", cursor: 0 }).where(eq(State.version, version)).run()
          return true
        }
        tx.update(State).set({ cursor }).where(eq(State.version, version)).run()
        if (cursor >= state.fts_end) {
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
      let cursor = state.cursor
      for (const row of rows) {
        if (cursor !== state.cursor && performance.now() - started >= budgetMs) break
        indexImportedParts(tx, [row.id])
        cursor = row.rowid
      }
      tx.update(State)
        .set(rows.length ? { cursor } : { phase: "done" })
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
    if (state?.phase === "done") {
      jobs.delete(db)
      return
    }
  } catch (error) {
    log.warn("index migration unavailable", { error: String(error) })
    jobs.delete(db)
    return
  }
  const clearJob = () => {
    if (jobs.get(db) === abort) jobs.delete(db)
  }
  const run = (attempt = 0) => {
    if (abort.signal.aborted) {
      clearJob()
      return
    }
    const started = performance.now()
    try {
      // Target <=5% duty cycle for this migration, including transaction commit.
      // A synchronous row/commit cannot be preempted; compensate with a longer rest.
      if (migrateIndexBatch(db)) {
        const elapsed = performance.now() - started
        setTimeout(() => run(0), Math.max(100, Math.ceil(elapsed * 19))).unref()
        return
      }
      clearJob()
    } catch (error) {
      log.warn("index migration paused", { error: String(error), attempt })
      // Limited in-process backoff; clear slot so a later startIndexMigration can retry.
      if (attempt >= 5 || abort.signal.aborted) {
        clearJob()
        return
      }
      setTimeout(() => run(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt)).unref()
    }
  }
  setTimeout(() => run(0), 1000).unref()
}

export function stopIndexMigration(db: ReturnType<typeof Database.Client>) {
  jobs.get(db)?.abort()
  jobs.delete(db)
}

export const MIGRATION_VERSION = version
