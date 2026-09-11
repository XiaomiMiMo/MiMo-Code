import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"

// [TP-ST-R10-02, TP-ST-R10-09, TP-ST-R2-07] Apply the actual SQL, not a hand-copied migration.
test("migration protects unknown titles without changing session restore behavior", async () => {
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
    db.exec("CREATE TABLE session_deleted_identity (id text PRIMARY KEY NOT NULL)")
    db.exec("CREATE TRIGGER session_identity_remember AFTER DELETE ON session BEGIN INSERT OR IGNORE INTO session_deleted_identity VALUES (OLD.id); END")
    db.exec("CREATE TRIGGER session_identity_no_reuse BEFORE INSERT ON session WHEN EXISTS (SELECT 1 FROM session_deleted_identity WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT, 'identity reserved'); END")
    const scope = await Bun.file(new URL("../../migration/20260908000000_session_title_scope/migration.sql", import.meta.url)).text()
    db.transaction(() => db.exec(scope))()
    expect(db.prepare("SELECT count(*) AS count FROM session").get()).toEqual({ count: 4 })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='session_deleted_identity'").get()).toBeNull()
    db.exec("DELETE FROM session WHERE id='a'")
    db.exec("INSERT INTO session(id,title) VALUES('a','Restored')")
    expect(db.prepare("SELECT title,title_source,title_revision FROM session WHERE id='a'").get()).toEqual({ title: "Restored", title_source: "user", title_revision: 0 })
  } finally {
    db.close()
  }
})
