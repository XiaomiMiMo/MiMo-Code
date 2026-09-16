import { eq } from "drizzle-orm"
import type { Database } from "../storage"
import { HistoryIndexMigrationTable as State } from "./fts.sql"
import { Log } from "../util"
import { migrateIndexBatch, MIGRATION_VERSION } from "./migration-batch"

export { migrateIndexBatch, MIGRATION_VERSION }

const log = Log.create({ service: "history.migration" })
const jobs = new WeakMap<ReturnType<typeof Database.Client>, AbortController>()

export function startIndexMigration(
  db: ReturnType<typeof Database.Client>,
  deps: { migrate?: (db: ReturnType<typeof Database.Client>) => boolean } = {},
) {
  const migrate = deps.migrate ?? migrateIndexBatch
  if (jobs.has(db)) return
  const abort = new AbortController()
  jobs.set(db, abort)
  try {
    const state = db.select().from(State).where(eq(State.version, MIGRATION_VERSION)).get()
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
      if (migrate(db)) {
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
