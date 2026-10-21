import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrateReplaySafe } from "../../src/storage/migrate-replay-safe"

const dir = new URL("../../migration/", import.meta.url)
const NAME = "20261021000000_actor_provenance"
const CANDIDATE_NAME = "20261008000000_actor_provenance"

function entry(name: string, sql: string) {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)!
  return { name, sql, timestamp: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) }
}

const provenanceSql = readFileSync(new URL(`${NAME}/migration.sql`, dir), "utf8")

function open() {
  const sqlite = new Database(":memory:")
  sqlite.exec("CREATE TABLE actor_registry (id TEXT PRIMARY KEY); CREATE TABLE task (id TEXT PRIMARY KEY)")
  return { sqlite, db: drizzle({ client: sqlite }) }
}

function columns(sqlite: Database, table: string) {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
}

// [TP-R23-05] Provenance columns must reach databases already migrated past every earlier migration.
test("actor provenance migration sorts after the migrations it was ported onto", () => {
  const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  expect(names).toContain(NAME)
  expect(names).toContain("20261013000000_inbox_queue")
  expect(names).not.toContain(CANDIDATE_NAME)
  expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf("20261013000000_inbox_queue"))
})

test("actor provenance applies once to a database already at the latest upstream migration", () => {
  const { sqlite, db } = open()
  try {
    const latest = entry("20261013000000_inbox_queue", "SELECT 1")
    migrateReplaySafe(db as never, [latest])
    migrateReplaySafe(db as never, [latest, entry(NAME, provenanceSql)])
    migrateReplaySafe(db as never, [latest, entry(NAME, provenanceSql)])
    expect(columns(sqlite, "actor_registry")).toEqual(
      expect.arrayContaining(["source_session_id", "source_call_id", "source_turn_id", "execution_generation"]),
    )
    expect(columns(sqlite, "task")).toContain("source_call_id")
    expect(sqlite.query("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 2 })
  } finally {
    sqlite.close()
  }
})

test("a database created by the Desktop candidate migration name keeps its provenance data", () => {
  const { sqlite, db } = open()
  try {
    migrateReplaySafe(db as never, [entry(CANDIDATE_NAME, provenanceSql)])
    sqlite.exec(
      "INSERT INTO actor_registry (id, source_session_id, source_call_id, source_turn_id, execution_generation) VALUES ('actor', 'session', 'call', 'turn', 2)",
    )
    sqlite.exec("INSERT INTO task (id, source_call_id) VALUES ('task', 'call')")
    // The renamed migration replays its additive columns; duplicate ALTERs are replay-safe no-ops.
    expect(() =>
      migrateReplaySafe(db as never, [entry("20261013000000_inbox_queue", "SELECT 1"), entry(NAME, provenanceSql)]),
    ).not.toThrow()
    expect(sqlite.query("SELECT execution_generation, source_call_id FROM actor_registry").get()).toEqual({
      execution_generation: 2,
      source_call_id: "call",
    })
    expect(sqlite.query("SELECT source_call_id FROM task").get()).toEqual({ source_call_id: "call" })
  } finally {
    sqlite.close()
  }
})
