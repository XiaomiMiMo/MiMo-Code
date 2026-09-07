import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"

// [TP-ST-R10-02, TP-ST-R10-09, TP-ST-R2-07] Apply the actual SQL, not a hand-copied migration.
test("migration protects unknown titles atomically and prevents identity reuse or source unlock", async () => {
  const sql = await Bun.file(
    new URL("../../migration/20260901000000_session_title_authority/migration.sql", import.meta.url),
  ).text()
  const db = new Database(":memory:")
  try {
    db.exec("CREATE TABLE session (id text PRIMARY KEY, title text NOT NULL)")
    for (const [id, title] of [
      ["a", "Generating title"],
      ["b", "ses_unknown"],
      ["c", "New session - 2026-01-01T00:00:00.000Z"],
      ["d", "   "],
    ])
      db.prepare("INSERT INTO session VALUES (?,?)").run(id, title)
    expect(() => db.transaction(() => db.exec(sql + "\nTHIS IS NOT SQL"))()).toThrow()
    expect(db.prepare("PRAGMA table_info(session)").all()).toHaveLength(2)
    db.transaction(() => db.exec(sql))()
    expect(db.prepare("SELECT id,title_source,title_revision FROM session ORDER BY id").all()).toEqual([
      { id: "a", title_source: "user", title_revision: 0 },
      { id: "b", title_source: "user", title_revision: 0 },
      { id: "c", title_source: "user", title_revision: 0 },
      { id: "d", title_source: "fallback", title_revision: 0 },
    ])
    expect(db.prepare("SELECT title FROM session WHERE id='d'").get()).toEqual({ title: "Untitled" })
    expect(() => db.exec("UPDATE session SET title_source='fallback',title_revision=1 WHERE id='a'")).toThrow(
      "invalid session title transition",
    )
    db.exec("UPDATE session SET title_revision=1 WHERE id='a'")
    expect(() => db.exec("UPDATE session SET title='Bypass' WHERE id='a'")).toThrow("invalid session title transition")
    db.exec("DELETE FROM session WHERE id='a'")
    expect(() => db.exec("INSERT INTO session(id,title) VALUES('a','Restored')")).toThrow(
      "deleted session identity cannot be reused",
    )
  } finally {
    db.close()
  }
})
