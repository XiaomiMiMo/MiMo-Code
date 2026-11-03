import { expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { Database } from "../../src/storage"

// engine-runtime [TP-R14-03] Apply the actual SQL to a database that still holds share data.
test("migration drops share records and the session share link", async () => {
  const sql = await Bun.file(
    new URL("../../migration/20261103000000_remove_session_share/migration.sql", import.meta.url),
  ).text()
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
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='session_share'").get()).toBeNull()
    expect(db.prepare("SELECT * FROM session").all()).toEqual([{ id: "ses_example", title: "Example" }])
  } finally {
    db.close()
  }
})

// engine-runtime [TP-R14-03]
test("the migrated engine database has no share storage", () => {
  const sqlite = Database.Client().$client
  expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='session_share'").get()).toBeNull()
  const columns = (sqlite.prepare("PRAGMA table_info(session)").all() as { name: string }[]).map((column) => column.name)
  expect(columns).toContain("title")
  expect(columns).not.toContain("share_url")
})
