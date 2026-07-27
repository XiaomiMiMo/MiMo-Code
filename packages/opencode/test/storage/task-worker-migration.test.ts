import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "fs"
import os from "os"
import path from "path"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { sql } from "drizzle-orm"
import { init } from "../../src/storage/db.bun"

const MIGRATION_DIR = path.join(import.meta.dirname, "../../migration")
const NEW_MIGRATION = "20260715000000_task_worker_link"

type Journal = { sql: string; timestamp: number; name: string }[]

function stamp(tag: string) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!m) return 0
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

function journal(): Journal {
  return readdirSync(MIGRATION_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(MIGRATION_DIR, name, "migration.sql")))
    .map((name) => ({
      sql: readFileSync(path.join(MIGRATION_DIR, name, "migration.sql"), "utf-8"),
      timestamp: stamp(name),
      name,
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

describe("task worker-link migration", () => {
  test("applies on an existing DB and backfills old task rows with NULLs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "task-worker-migration-"))
    const db = init(path.join(dir, "test.db"))
    db.$client.run("PRAGMA foreign_keys = ON")

    const all = journal()
    const before = all.filter((m) => m.name !== NEW_MIGRATION)
    expect(before.length).toBe(all.length - 1)
    // the new migration must sort last so it applies after every existing one
    expect(all[all.length - 1].name).toBe(NEW_MIGRATION)

    // 1. bring the DB up to the state that shipped before this PR
    migrate(db, before)

    // pre-migration `task` has no worker columns
    const oldCols = db.$client
      .query("select name from pragma_table_info('task')")
      .all()
      .map((r: any) => r.name)
    expect(oldCols).not.toContain("worker_session_id")

    // 2. seed a legacy row through raw SQL (the old column set)
    db.$client.run(
      "insert into project (id, worktree, sandboxes, time_created, time_updated) values (?, ?, ?, ?, ?)",
      ["prj_legacy", dir, "[]", 1, 1],
    )
    db.$client.run(
      "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ["ses_legacy", "prj_legacy", "legacy", dir, "legacy", "0.0.0", 1, 1],
    )
    db.$client.run(
      "insert into task (id, session_id, status, summary, created_at, last_event_at) values (?, ?, ?, ?, ?, ?)",
      ["T1", "ses_legacy", "open", "legacy task", 1, 1],
    )

    // 3. apply the new migration
    migrate(db, all)

    const cols = db.$client
      .query("select name from pragma_table_info('task')")
      .all()
      .map((r: any) => r.name)
    expect(cols).toContain("worker_session_id")
    expect(cols).toContain("dispatched_at")
    expect(cols).toContain("result_ref")

    const row = db.$client
      .query("select worker_session_id, dispatched_at, result_ref, status from task where id = 'T1'")
      .get() as any
    expect(row.worker_session_id).toBeNull()
    expect(row.dispatched_at).toBeNull()
    expect(row.result_ref).toBeNull()
    expect(row.status).toBe("open")

    const indexes = db.$client
      .query("select name from sqlite_master where type = 'index' and tbl_name = 'task'")
      .all()
      .map((r: any) => r.name)
    expect(indexes).toContain("task_worker_idx")

    // the new columns are writable on the legacy row
    db.all(sql`update task set worker_session_id = 'ses_worker', dispatched_at = 42 where id = 'T1'`)
    const updated = db.$client
      .query("select worker_session_id, dispatched_at from task where id = 'T1'")
      .get() as any
    expect(updated.worker_session_id).toBe("ses_worker")
    expect(updated.dispatched_at).toBe(42)

    db.$client.close()
  })
})
