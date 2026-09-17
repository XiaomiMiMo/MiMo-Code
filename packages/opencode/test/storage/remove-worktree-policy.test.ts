import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"

test("worktree policy migration preserves existing session data", () => {
  const db = new Database(":memory:")
  try {
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, auto_worktree_hint_sent INTEGER)")
    db.exec("INSERT INTO session VALUES ('session-example', 'Existing session', 1)")
    db.exec(
      readFileSync(
        new URL("../../migration/20260917000000_remove_auto_worktree/migration.sql", import.meta.url),
        "utf8",
      ),
    )
    expect(db.query("SELECT * FROM session").all()).toEqual([{ id: "session-example", title: "Existing session" }])
    expect(
      db
        .query("PRAGMA table_info(session)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(["id", "title"])
  } finally {
    db.close()
  }
})
