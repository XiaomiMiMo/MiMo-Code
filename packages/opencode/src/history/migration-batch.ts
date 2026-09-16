/**
 * v6 index rebuild batch — pure DB path, no Log/Global side effects.
 * Scheduler (startIndexMigration) lives in `./migration`.
 */
import { and, asc, eq, gt, lte, sql } from "drizzle-orm"
import type { Database } from "../storage"
import type { PartID } from "../session/schema"
import { PartTable } from "../session/session.sql"
import { HistoryFtsTable, HistoryIndexMigrationTable as State } from "./fts.sql"
import { indexImportedParts } from "./import"
import { basePartId } from "./chunk"
import { deleteHistoryRows } from "./chunk-write"

/** v6: drop legacy chunks/orphans; rebuild one truncated index row per part. */
export const MIGRATION_VERSION = 6
const batch = 32
const budgetMs = 8

/** One bounded, atomic batch. Other processes reread the cursor under the lock. */
export function migrateIndexBatch(db: ReturnType<typeof Database.Client>) {
  const started = performance.now()
  return db.transaction(
    (tx) => {
      const state = tx.select().from(State).where(eq(State.version, MIGRATION_VERSION)).get()
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
          tx.update(State).set({ phase: "repair", cursor: 0 }).where(eq(State.version, MIGRATION_VERSION)).run()
          return true
        }
        tx.update(State).set({ cursor }).where(eq(State.version, MIGRATION_VERSION)).run()
        if (cursor >= state.fts_end) {
          tx.update(State).set({ phase: "repair", cursor: 0 }).where(eq(State.version, MIGRATION_VERSION)).run()
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
        .where(eq(State.version, MIGRATION_VERSION))
        .run()
      return rows.length > 0
    },
    { behavior: "immediate" },
  )
}
