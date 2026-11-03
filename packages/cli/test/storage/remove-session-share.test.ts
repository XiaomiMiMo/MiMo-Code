import { expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { Database } from "../../src/storage"
import { migrateReplaySafe } from "../../src/storage/migrate-replay-safe"
import { SessionTable } from "../../src/session/session.sql"

const migration = new URL("../../migration/20261103000000_remove_session_share/migration.sql", import.meta.url)

// engine-runtime [TP-R14-03] Apply the actual SQL to a database that still holds share data.
test("migration clears share data but keeps the schema older clients use", async () => {
  const sql = await Bun.file(migration).text()
  const db = new Sqlite(":memory:")
  try {
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("CREATE TABLE session (id text PRIMARY KEY, title text NOT NULL, share_url text)")
    db.exec(
      "CREATE TABLE session_share (session_id text PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE, id text NOT NULL, secret text NOT NULL, url text NOT NULL)",
    )
    db.exec("INSERT INTO session VALUES ('ses_example', 'Example', 'https://example.com/share/example')")
    db.exec("INSERT INTO session_share VALUES ('ses_example', 'example', 'example', 'https://example.com/share/example')")
    db.transaction(() => db.exec(sql))()
    expect(db.prepare("SELECT * FROM session").all()).toEqual([{ id: "ses_example", title: "Example", share_url: null }])
    expect(db.prepare("SELECT count(*) AS count FROM session_share").get()).toEqual({ count: 0 })
    // What an older client sharing this database still does.
    db.exec("INSERT INTO session (id, title, share_url) VALUES ('ses_older', 'Older', NULL)")
    expect(db.prepare("SELECT share_url FROM session WHERE id = 'ses_older'").get()).toEqual({ share_url: null })
    expect(db.prepare("SELECT * FROM session_share WHERE session_id = 'ses_older'").get()).toBeNull()
  } finally {
    db.close()
  }
})

// engine-runtime [TP-R14-03] The full migration chain must not drop what older clients still query.
test("the migrated engine database keeps share storage for older clients", () => {
  const sqlite = Database.Client().$client
  expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='session_share'").get()).toEqual({ name: "session_share" })
  const columns = (sqlite.prepare("PRAGMA table_info(session)").all() as { name: string }[]).map((column) => column.name)
  expect(columns).toContain("share_url")
})

// engine-runtime [TP-R14-03] Databases that ran the earlier dropping draft must still start and serve sessions.
test("databases migrated by the dropping draft skip the clearing migration", () => {
  const dir = path.join(import.meta.dirname, "../../migration")
  const journal = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(path.join(dir, entry.name, "migration.sql"), "utf-8"),
      timestamp: Number(entry.name.split("_")[0]),
      name: entry.name,
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
  const name = "20261103000000_remove_session_share"
  const draft = journal.map((entry) =>
    entry.name === name
      ? { ...entry, sql: "DROP TABLE IF EXISTS `session_share`;--> statement-breakpoint\nALTER TABLE `session` DROP COLUMN `share_url`;" }
      : entry,
  )
  const sqlite = new Sqlite(":memory:")
  try {
    const db = drizzle({ client: sqlite })
    migrateReplaySafe(db, draft)
    expect(() => migrateReplaySafe(db, journal)).not.toThrow()
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='session_share'").get()).toBeNull()
    expect(db.select().from(SessionTable).all()).toEqual([])
  } finally {
    sqlite.close()
  }
})
