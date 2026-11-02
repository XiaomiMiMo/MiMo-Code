import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { migrateReplaySafe } from "../../src/storage/migrate-replay-safe"
import { tmpdir } from "../fixture/fixture"
import { migrateMemoryIndex } from "../../src/memory/migration"
import { buildFtsQuery } from "../../src/memory/fts-query"
import { buildSearchIndexText } from "../../src/memory/search-text"

function openLegacyDb() {
  const sqlite = new BunDatabase(":memory:")
  for (const name of ["20260521010000_memory_fts_v6", "20260521020000_memory_fts_triggers"]) {
    sqlite.exec(readFileSync(new URL(`../../migration/${name}/migration.sql`, import.meta.url), "utf8"))
  }
  const insert = sqlite.prepare(`INSERT INTO memory_fts(path, scope, scope_id, type, body, fingerprint, last_indexed_at)
    VALUES (?, 'global', '', 'free', ?, 'unchanged-fingerprint', 123)`)
  insert.run("/tmp/example/knowledge.md", "把所有项目知识总结进一个文档。这是本周的目标。")
  insert.run("/tmp/example/mixed.md", "npm打包脚本2支持JWT认证。")
  insert.run("/tmp/example/empty.md", "")
  insert.run("/tmp/example/spaces.md", " \n\t ")
  return sqlite
}

const migration = readFileSync(new URL("../../migration/20261102000000_memory_cjk_unigram/migration.sql", import.meta.url), "utf8")

function matches(sqlite: BunDatabase, query: string) {
  return sqlite.prepare(`SELECT path FROM memory_fts_idx JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
    WHERE memory_fts_idx MATCH ? ORDER BY path`).all(buildFtsQuery(query) ?? "")
}

// [TP-R6-07] Upgrade real shipped SQL without changing source rows or fingerprints.
describe("Chinese memory index migration", () => {
  test("database startup upgrades a persisted legacy index before any reconcile", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "engine.db")
    const sqlite = new BunDatabase(dbPath)
    try {
      const dir = new URL("../../migration/", import.meta.url)
      const entries = readdirSync(dir)
        .filter((name) => /^\d{14}_/.test(name) && name < "20261102000000")
        .sort()
        .map((name) => ({
          name,
          sql: readFileSync(new URL(`${name}/migration.sql`, dir), "utf8"),
          timestamp: Date.UTC(Number(name.slice(0, 4)), Number(name.slice(4, 6)) - 1,
            Number(name.slice(6, 8)), Number(name.slice(8, 10)), Number(name.slice(10, 12)), Number(name.slice(12, 14))),
        }))
      migrateReplaySafe(drizzle({ client: sqlite }), entries)
      sqlite.prepare(`INSERT INTO memory_fts(path, scope, scope_id, type, body, fingerprint, last_indexed_at)
        VALUES ('/tmp/example/knowledge.md', 'global', '', 'free', '把所有项目知识总结进一个文档', 'unchanged', 123)`).run()
    } finally {
      sqlite.close()
    }
    const child = Bun.spawn([process.execPath, "--eval", `
      import { Database } from "./src/storage"
      import { buildFtsQuery } from "./src/memory/fts-query"
      const db = Database.Client().$client
      console.log("startup-result:" + JSON.stringify({
        hits: db.prepare("SELECT path FROM memory_fts_idx JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid WHERE memory_fts_idx MATCH ?").all(buildFtsQuery("项目知识")),
        row: db.prepare("SELECT body, fingerprint, last_indexed_at FROM memory_fts").get(),
        pending: db.prepare("SELECT * FROM memory_index_migration").all(),
      }))
      Database.close()
    `], { cwd: path.resolve(import.meta.dir, "../.."), env: { ...process.env, MIMOCODE_DB: dbPath }, stdout: "pipe", stderr: "pipe" })
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(code, error).toBe(0)
    const result = output.split("\n").find((line) => line.startsWith("startup-result:"))
    expect(result).toBeDefined()
    expect(JSON.parse(result!.slice("startup-result:".length))).toEqual({
      hits: [{ path: "/tmp/example/knowledge.md" }],
      row: { body: "把所有项目知识总结进一个文档", fingerprint: "unchanged", last_indexed_at: 123 },
      pending: [],
    })
  })

  test("backfills existing rows before search and keeps triggers consistent", () => {
    const sqlite = openLegacyDb()
    try {
      const before = sqlite.prepare("SELECT * FROM memory_fts ORDER BY id").all() as Array<Record<string, unknown>>
      expect(matches(sqlite, "项目知识")).toEqual([])
      sqlite.exec(migration)
      const db = drizzle({ client: sqlite })
      migrateMemoryIndex(db)
      const after = sqlite.prepare("SELECT * FROM memory_fts ORDER BY id").all() as Array<Record<string, unknown>>
      expect(after.map(({ body_idx, ...row }) => row)).toEqual(before)
      expect(after.map((row) => row.body_idx)).toEqual(after.map((row) => buildSearchIndexText(String(row.body))))
      expect(matches(sqlite, "项目知识")).toEqual([{ path: "/tmp/example/knowledge.md" }])
      expect(matches(sqlite, "文档")).toHaveLength(1)
      expect(matches(sqlite, "npm打包脚本2")).toEqual([{ path: "/tmp/example/mixed.md" }])
      expect(sqlite.prepare("SELECT * FROM memory_index_migration").all()).toEqual([])
      migrateMemoryIndex(db)
      expect(sqlite.prepare("SELECT * FROM memory_fts ORDER BY id").all()).toEqual(after)

      const body = "新的检索内容"
      sqlite.prepare("UPDATE memory_fts SET body = ?, body_idx = ? WHERE id = 1").run(body, buildSearchIndexText(body))
      expect(matches(sqlite, "项目知识")).toEqual([])
      expect(matches(sqlite, "检索")).toHaveLength(1)
      sqlite.prepare("DELETE FROM memory_fts WHERE id = 1").run()
      expect(matches(sqlite, "检索")).toEqual([])
      sqlite.exec("INSERT INTO memory_fts_idx(memory_fts_idx, rank) VALUES('integrity-check', 1)")
    } finally {
      sqlite.close()
    }
  })

  test("failed backfill rolls back all rows and retries the pending migration", () => {
    const sqlite = openLegacyDb()
    try {
      sqlite.exec(migration)
      sqlite.exec("CREATE TRIGGER fail_backfill BEFORE UPDATE ON memory_fts WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'test interruption'); END")
      const db = drizzle({ client: sqlite })
      expect(() => migrateMemoryIndex(db)).toThrow()
      expect(sqlite.prepare("SELECT body_idx FROM memory_fts").all()).toEqual(Array.from({ length: 4 }, () => ({ body_idx: "" })))
      expect(sqlite.prepare("SELECT version FROM memory_index_migration").all()).toEqual([{ version: 1 }])
      sqlite.exec("DROP TRIGGER fail_backfill")
      migrateMemoryIndex(db)
      expect(matches(sqlite, "项目知识")).toHaveLength(1)
      expect(sqlite.prepare("SELECT * FROM memory_index_migration").all()).toEqual([])
      sqlite.exec("INSERT INTO memory_fts_idx(memory_fts_idx, rank) VALUES('integrity-check', 1)")
    } finally {
      sqlite.close()
    }
  })
})
