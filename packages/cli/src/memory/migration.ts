import { asc, eq, gt } from "drizzle-orm"
import type { Database } from "../storage"
import { Log } from "../util"
import { MemoryFtsTable, MemoryIndexMigrationTable } from "./fts.sql"
import { buildSearchIndexText } from "./search-text"

type Client = ReturnType<typeof Database.Client>

const log = Log.create({ service: "memory.migration" })
const jobs = new WeakMap<Client, AbortController>()
const batch = 32
const budgetMs = 8
const retryMs = 30_000

/**
 * One bounded, atomic backfill batch; true while rows remain. The persisted id cursor
 * keeps each batch a short rowid range scan, and a restart resumes where it stopped.
 */
export function migrateMemoryIndexBatch(db: Client): boolean {
  const started = performance.now()
  return db.transaction(
    (tx) => {
      const state = tx.select().from(MemoryIndexMigrationTable).where(eq(MemoryIndexMigrationTable.version, 1)).get()
      if (!state) return false
      const rows = tx
        .select({ id: MemoryFtsTable.id, body: MemoryFtsTable.body })
        .from(MemoryFtsTable)
        .where(gt(MemoryFtsTable.id, state.cursor))
        .orderBy(asc(MemoryFtsTable.id))
        .limit(batch)
        .all()
      if (!rows.length) {
        tx.delete(MemoryIndexMigrationTable).where(eq(MemoryIndexMigrationTable.version, 1)).run()
        return false
      }
      let cursor = state.cursor
      for (const row of rows) {
        tx.update(MemoryFtsTable)
          .set({ body_idx: buildSearchIndexText(row.body) })
          .where(eq(MemoryFtsTable.id, row.id))
          .run()
        cursor = row.id
        if (performance.now() - started > budgetMs) break
      }
      tx.update(MemoryIndexMigrationTable).set({ cursor }).where(eq(MemoryIndexMigrationTable.version, 1)).run()
      return true
    },
    { behavior: "immediate" },
  )
}

/**
 * Desktop runs the engine on the Electron main thread, so the backfill must not run inside
 * Database.Client(). memory_fts caches disk files: rows awaiting backfill are only briefly
 * unsearchable, and an unfinished backfill resumes on the next boot.
 */
export function startMemoryIndexMigration(db: Client) {
  // Plain read: a steady-state boot must not queue behind another engine's writer lock.
  if (!db.select().from(MemoryIndexMigrationTable).where(eq(MemoryIndexMigrationTable.version, 1)).get()) return
  const abort = new AbortController()
  jobs.set(db, abort)
  const run = () => {
    if (abort.signal.aborted) return
    const started = performance.now()
    try {
      if (migrateMemoryIndexBatch(db)) {
        // <=5% duty cycle, as in history/migration.ts.
        setTimeout(run, Math.max(100, Math.ceil((performance.now() - started) * 19))).unref()
        return
      }
      jobs.delete(db)
    } catch (error) {
      // A throw from a timer would crash the host process; another engine may hold the writer lock.
      log.warn("memory index backfill paused", { error: String(error) })
      setTimeout(run, retryMs).unref()
    }
  }
  setTimeout(run, 1000).unref()
}

export function stopMemoryIndexMigration(db: Client) {
  jobs.get(db)?.abort()
  jobs.delete(db)
}
