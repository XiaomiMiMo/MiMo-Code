import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

test("Node migration updates the trigger to delete chunked history rows", () => {
  const result = spawnSync("node", ["--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { readFileSync } from "node:fs"
    import { DatabaseSync } from "node:sqlite"
    import { drizzle } from "drizzle-orm/node-sqlite"
    import { migrate } from "drizzle-orm/bun-sqlite/migrator"
    const sqlite = new DatabaseSync(":memory:")
    sqlite.exec(\`
      CREATE TABLE part (id TEXT PRIMARY KEY);
      CREATE TABLE history_fts (part_id TEXT PRIMARY KEY);
      CREATE TABLE history_index_migration (
        version INTEGER PRIMARY KEY, phase TEXT, cursor INTEGER, fts_end INTEGER, part_end INTEGER
      );
      CREATE TRIGGER history_part_ad AFTER DELETE ON part BEGIN
        DELETE FROM history_fts WHERE part_id = OLD.id;
      END;
      INSERT INTO part VALUES ('prt_under_score'), ('prt_other');
      INSERT INTO history_fts VALUES ('prt_under_score'), ('prt_under_score#0'), ('prt_under_score#1'), ('prt_other#0');
    \`)
    migrate(drizzle({ client: sqlite }), [{
      sql: readFileSync("migration/20260915010000_history_chunk_bodies/migration.sql", "utf8"),
      timestamp: 1789434000000,
      name: "20260915010000_history_chunk_bodies",
    }])
    assert.equal(sqlite.prepare("SELECT phase FROM history_index_migration WHERE version=5").get().phase, "clean")
    sqlite.prepare("DELETE FROM part WHERE id=?").run("prt_under_score")
    assert.deepEqual(sqlite.prepare("SELECT part_id FROM history_fts").all().map(row => row.part_id), ["prt_other#0"])
    sqlite.close()
  `], { cwd: new URL("../../", import.meta.url), encoding: "utf8" })
  expect(result.stderr).not.toContain("AssertionError")
  expect(result.status).toBe(0)
})
