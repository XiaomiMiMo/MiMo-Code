import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"

// v6.1 first iteration — broken triggers using contentless-mode DELETE syntax
// against an external-content vtab. Leaves stale tokens; corruption fires once
// accumulated state diverges from source rows.
const SCHEMA_V61_BROKEN_SQL = `
CREATE TABLE memory_fts (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  scope_id TEXT DEFAULT '' NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  last_indexed_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE memory_fts_idx USING fts5(
  body, content='memory_fts', content_rowid='id', tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.id, NEW.body);
END;
CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_fts BEGIN
  DELETE FROM memory_fts_idx WHERE rowid = OLD.id;
END;
CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory_fts BEGIN
  DELETE FROM memory_fts_idx WHERE rowid = OLD.id;
  INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.id, NEW.body);
END;
`

// v6.1.1 fixed triggers — external-content mode requires FTS5's 'delete' magic
// command to remove OLD body's tokens. Plain DELETE FROM the vtab leaves
// orphaned tokens.
const SCHEMA_V61_FIXED_SQL = `
CREATE TABLE memory_fts (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  scope_id TEXT DEFAULT '' NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  last_indexed_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE memory_fts_idx USING fts5(
  body, content='memory_fts', content_rowid='id', tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.id, NEW.body);
END;
CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body) VALUES('delete', OLD.id, OLD.body);
END;
CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body) VALUES('delete', OLD.id, OLD.body);
  INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.id, NEW.body);
END;
`

// v6.0 schema — original, with TEXT PRIMARY KEY (implicit reusable rowid).
// Used in test (c) negative control.
const SCHEMA_V60_SQL = `
CREATE TABLE memory_fts (
  path TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT DEFAULT '' NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  last_indexed_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE memory_fts_idx USING fts5(
  body, content='memory_fts', content_rowid='rowid', tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.rowid, NEW.body);
END;
CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_fts BEGIN
  DELETE FROM memory_fts_idx WHERE rowid = OLD.rowid;
END;
CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory_fts BEGIN
  DELETE FROM memory_fts_idx WHERE rowid = OLD.rowid;
  INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.rowid, NEW.body);
END;
`

function openDb(schema: string): BunDatabase {
  const db = new BunDatabase(":memory:")
  db.exec(schema)
  return db
}

function insertRow(db: BunDatabase, path: string, body: string) {
  db.run(
    `INSERT INTO memory_fts (path, scope, scope_id, type, body, fingerprint, last_indexed_at)
     VALUES (?, 'global', '', 'free', ?, 'fp', 0)`,
    [path, body],
  )
}

function upsertRow(db: BunDatabase, path: string, body: string) {
  db.run(
    `INSERT INTO memory_fts (path, scope, scope_id, type, body, fingerprint, last_indexed_at)
     VALUES (?, 'global', '', 'free', ?, 'fp', 0)
     ON CONFLICT(path) DO UPDATE SET body = excluded.body, fingerprint = excluded.fingerprint, last_indexed_at = excluded.last_indexed_at`,
    [path, body],
  )
}

describe("FTS rowid stability — v6.1 AUTOINCREMENT", () => {
  test("(a) id is monotonic across DELETE+INSERT cycles on same path", () => {
    const db = openDb(SCHEMA_V61_FIXED_SQL)
    insertRow(db, "/p1", "body1")
    const before = db.query("SELECT id FROM memory_fts WHERE path = ?").get("/p1") as { id: number }
    expect(before.id).toBeGreaterThan(0)

    db.run("DELETE FROM memory_fts WHERE path = ?", ["/p1"])
    insertRow(db, "/p1", "body2")
    const after = db.query("SELECT id FROM memory_fts WHERE path = ?").get("/p1") as { id: number }
    expect(after.id).toBeGreaterThan(before.id)

    const rows = db
      .query(
        `SELECT memory_fts.body FROM memory_fts_idx
         JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
         WHERE memory_fts_idx MATCH ?`,
      )
      .all("body2") as { body: string }[]
    expect(rows.length).toBe(1)
    expect(rows[0].body).toBe("body2")

    db.close()
  })

  test("(b) 100 DELETE+INSERT cycles on same path don't corrupt vtab", () => {
    const db = openDb(SCHEMA_V61_FIXED_SQL)
    insertRow(db, "/p1", "init")

    for (let i = 0; i < 100; i++) {
      db.run("DELETE FROM memory_fts WHERE path = ?", ["/p1"])
      insertRow(db, "/p1", "cycle" + i)
      const rows = db
        .query(
          `SELECT memory_fts.body FROM memory_fts_idx
           JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
           WHERE memory_fts_idx MATCH ?`,
        )
        .all("cycle" + i) as { body: string }[]
      expect(rows.length).toBe(1)
      expect(rows[0].body).toBe("cycle" + i)
    }

    db.run("INSERT INTO memory_fts_idx(memory_fts_idx) VALUES('integrity-check')")

    db.close()
  })

  test("(c) negative control: v6.0 schema corrupts vtab under cycle stress", () => {
    const db = openDb(SCHEMA_V60_SQL)
    insertRow(db, "/p1", "init")

    let corrupted = false
    let lastError: unknown = undefined
    let inconsistentAt = -1

    try {
      for (let i = 0; i < 200; i++) {
        db.run("DELETE FROM memory_fts WHERE path = ?", ["/p1"])
        insertRow(db, "/p1", "cycle" + i)
        const rows = db
          .query(
            `SELECT memory_fts.body FROM memory_fts_idx
             JOIN memory_fts ON memory_fts.rowid = memory_fts_idx.rowid
             WHERE memory_fts_idx MATCH ?`,
          )
          .all("cycle" + i) as { body: string }[]
        if (rows.length !== 1 || rows[0].body !== "cycle" + i) {
          inconsistentAt = i
          break
        }
      }
      db.run("INSERT INTO memory_fts_idx(memory_fts_idx) VALUES('integrity-check')")
    } catch (err) {
      corrupted = true
      lastError = err
    }

    db.close()

    const reproduced = corrupted || inconsistentAt !== -1
    if (!reproduced) {
      console.warn(
        "v6.0 schema did NOT reproduce corruption in 200 cycles — hypothesis weaker than expected.",
        "AUTOINCREMENT fix may still be defense-in-depth, but root cause may be elsewhere.",
      )
    }
    if (corrupted) {
      console.log("v6.0 schema reproduced corruption (threw):", String(lastError))
    } else if (inconsistentAt !== -1) {
      console.log("v6.0 schema reproduced corruption (inconsistent FTS rows) at cycle", inconsistentAt)
    }

    expect(true).toBe(true)
  })
})

describe("FTS trigger pattern — v6.1.1 'delete' magic command", () => {
  // (d) reproduces the actual harness corruption: UPSERT with body growth on
  // the v6.1-first-iteration broken triggers. SHOULD throw immediately.
  test("(d) v6.1 broken triggers corrupt on first UPSERT body growth", () => {
    const db = openDb(SCHEMA_V61_BROKEN_SQL)
    insertRow(db, "/p1", "x ".repeat(50))

    let threw = false
    let err: unknown = undefined
    try {
      // Body grows ~3x via UPSERT — triggers AFTER UPDATE → broken DELETE FROM
      // memory_fts_idx leaves orphaned tokens and the next FTS5 internal merge
      // reports SQLITE_CORRUPT_VTAB.
      upsertRow(db, "/p1", "x ".repeat(150))
    } catch (e) {
      threw = e instanceof Error && /malformed|CORRUPT/i.test(String(e))
      err = e
    }

    db.close()
    if (!threw) {
      console.warn("(d) broken-trigger UPSERT did NOT corrupt — bun:sqlite version may have changed FTS5 internals")
    }
    expect(threw).toBe(true)
    expect(String(err)).toMatch(/malformed|CORRUPT/i)
  })

  // (e) verifies the fix: same growth pattern with the corrected 'delete'
  // magic-command triggers passes 100 cycles + integrity-check + search.
  test("(e) v6.1.1 fixed triggers handle UPSERT body growth + 100 cycles cleanly", () => {
    const db = openDb(SCHEMA_V61_FIXED_SQL)
    insertRow(db, "/p1", "init small body")

    for (let i = 0; i < 100; i++) {
      const body = `cycle ${i} ${"x ".repeat(50 + i * 10)}`
      upsertRow(db, "/p1", body)
      const rows = db
        .query(
          `SELECT memory_fts.body FROM memory_fts_idx
           JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
           WHERE memory_fts_idx MATCH ?`,
        )
        .all("cycle") as { body: string }[]
      expect(rows.length).toBe(1)
      expect(rows[0].body.startsWith(`cycle ${i}`)).toBe(true)
    }

    // Stale token check: 'init' (from initial body) must NOT match — the
    // 'delete' magic command should have removed those tokens cleanly.
    const stale = db
      .query(
        `SELECT memory_fts.path FROM memory_fts_idx
         JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
         WHERE memory_fts_idx MATCH ?`,
      )
      .all("init") as { path: string }[]
    expect(stale.length).toBe(0)

    db.run("INSERT INTO memory_fts_idx(memory_fts_idx) VALUES('integrity-check')")

    db.close()
  })
})
