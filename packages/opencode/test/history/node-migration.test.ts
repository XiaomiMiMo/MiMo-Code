import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

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
    sqlite.exec("UPDATE history_index_migration SET phase='done', cursor=42 WHERE version=5")
    migrate(drizzle({ client: sqlite }), [{
      sql: readFileSync("migration/20260916000000_history_single_row_index/migration.sql", "utf8"),
      timestamp: 1789516800000,
      name: "20260916000000_history_single_row_index",
    }])
    assert.equal(sqlite.prepare("SELECT phase FROM history_index_migration WHERE version=6").get().phase, "clean")
    // v6 SQL closes superseded migration state
    assert.equal(sqlite.prepare("SELECT phase FROM history_index_migration WHERE version=5").get().phase, "done")
    assert.equal(sqlite.prepare("SELECT cursor FROM history_index_migration WHERE version=5").get().cursor, 42)
    const trigger = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='history_part_ad'").get().sql
    const deletion = trigger.slice(trigger.indexOf("DELETE FROM"), trigger.lastIndexOf("END")).replaceAll("OLD.id", "'prt_under_score'")
    const plan = sqlite.prepare("EXPLAIN QUERY PLAN " + deletion).all()
    assert(!plan.some(row => /SCAN history_fts/.test(row.detail)))
    assert(plan.some(row => /SEARCH history_fts.*INDEX/.test(row.detail)))
    sqlite.prepare("DELETE FROM part WHERE id=?").run("prt_under_score")
    assert.deepEqual(sqlite.prepare("SELECT part_id FROM history_fts").all().map(row => row.part_id), ["prt_other#0"])
    sqlite.close()
  `], { cwd: new URL("../../", import.meta.url), encoding: "utf8" })
  expect(result.stderr).not.toContain("AssertionError")
  expect(result.status).toBe(0)
})

// R7: real TS migrateIndexBatch clean+repair on node:sqlite.
// Bun cannot import node:sqlite; Node runs a bun-built bundle of the TS path.
test("migrateIndexBatch clean and repair run on node:sqlite", () => {
  const cwd = fileURLToPath(new URL("../../", import.meta.url))
  const fixture = fileURLToPath(new URL("./fixtures/node-sqlite-migrate.ts", import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), "history-node-sqlite-"))
  const outfile = join(dir, "node-sqlite-migrate.mjs")
  const build = spawnSync(
    process.execPath,
    ["build", fixture, "--target=node", "--outfile", outfile, "--external", "node:sqlite"],
    { cwd, encoding: "utf8" },
  )
  expect(build.status).toBe(0)
  // Bun's bundle hits a TDZ on Global filesystem cache bootstrap under Node; skip that
  // non-migration init. migrateIndexBatch itself never touches the cache.
  let code = readFileSync(outfile, "utf8")
  code = code.replace(
    /var version2 = await exports_filesystem\.readText\([\s\S]*?\)\.catch\(\(\) => "0"\);/,
    'var version2 = "21";',
  )
  code = code.replace(/await exports_filesystem\.write\([\s\S]*?\);/g, "void 0;")
  writeFileSync(outfile, code)
  const run = spawnSync("node", [outfile], { cwd, encoding: "utf8" })
  expect(run.status).toBe(0)
  const line = run.stdout.trim().split("\n").filter(Boolean).pop()!
  expect(JSON.parse(line)).toMatchObject({ ok: true, phase: "done", ids: ["prt_big", "prt_ok"] })
})
