import { afterEach, expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "../../src/storage"
import { Migration } from "../../src/migration-node"

// Desktop data-migration [TP-R14a-01..03][TP-R16-01][TP-R17-02][TP-R17a-02]: merge another
// device's engine database, using the real migrated schema of this engine build.

const dirs: string[] = []
afterEach(() => {
  // Windows releases SQLite file handles lazily; a leftover temp dir must not fail the test.
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
})

function schemaSql(): string[] {
  const client = Database.Client().$client
  const rows = client
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    .all() as { type: string; name: string; sql: string }[]
  // Tables first (FTS shadow tables are created by their virtual table), then indexes and triggers.
  const order = { table: 0, index: 1, trigger: 2, view: 3 } as Record<string, number>
  const shadow = new Set(rows.filter((r) => /CREATE VIRTUAL TABLE/i.test(r.sql)).map((r) => r.name))
  return rows
    .filter((r) => ![...shadow].some((v) => r.name !== v && r.name.startsWith(`${v}_`)))
    .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))
    .map((r) => r.sql)
}

function freshDb(file: string, version: number): Sqlite {
  const db = new Sqlite(file)
  db.exec("PRAGMA foreign_keys = ON")
  for (const sql of schemaSql()) db.exec(sql)
  db.exec("DELETE FROM __drizzle_migrations")
  db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run("v", version)
  return db
}

function setup(versions: { local?: number; incoming?: number } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "engine-merge-"))
  dirs.push(dir)
  const local = freshDb(path.join(dir, "local.db"), versions.local ?? 100)
  const incoming = freshDb(path.join(dir, "incoming.db"), versions.incoming ?? 100)
  return { dir, local, incoming, incomingPath: path.join(dir, "incoming.db") }
}

const T = 1_800_000_000_000
function project(db: Sqlite, id: string, worktree: string, name: string) {
  db.prepare("INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, '[]')").run(id, worktree, name, T, T)
}
function session(db: Sqlite, id: string, opts: { project?: string; parent?: string; dir?: string; title?: string; messages?: number } = {}) {
  db.prepare(
    "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, 'v', ?, ?)",
  ).run(id, opts.project ?? "p1", opts.parent ?? null, id, opts.dir ?? "/old/ws/app", opts.title ?? id, T, T)
  for (let i = 0; i < (opts.messages ?? 1); i++) {
    const mid = `msg_${id}_${i}`
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(mid, id, T + i, T + i, JSON.stringify({ path: { cwd: "/old/ws/app" } }))
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(`prt_${mid}`, mid, id, T + i, T + i, JSON.stringify({ text: "see /old/ws/app/a.ts" }))
  }
}
const count = (db: Sqlite, sql: string) => Number((db.prepare(sql).get() as { n: number }).n)

test("conflicts: identical sessions are skipped, differing ones are listed", () => {
  const { local, incoming } = setup()
  for (const db of [local, incoming]) project(db, "p1", "/old/ws/app", "App")
  session(local, "ses_same")
  session(incoming, "ses_same")
  session(local, "ses_diff", { messages: 1 })
  session(incoming, "ses_diff", { messages: 3 })
  session(incoming, "ses_new")
  const conflicts = Migration.sessionConflicts(Migration.sessionInfos(local), Migration.sessionInfos(incoming))
  expect(conflicts.map((c) => c.id)).toEqual(["ses_diff"])
  expect(conflicts[0]).toMatchObject({ localMessages: 1, incomingMessages: 3 })
})

test("merge: imports new sessions with descendants, overwrites only chosen ones, keeps the rest, rewrites paths", () => {
  const { local, incoming, incomingPath } = setup()
  project(local, "p1", "/new/ws/app", "Local name")
  project(incoming, "p1", "/old/ws/app", "Incoming name")
  session(local, "ses_local_only")
  session(local, "ses_over", { messages: 1, title: "local over" })
  session(incoming, "ses_over", { messages: 2, title: "incoming over" })
  session(local, "ses_keep", { messages: 1, title: "local keep" })
  session(incoming, "ses_keep", { messages: 4, title: "incoming keep" })
  session(incoming, "ses_new", { messages: 2 })
  session(incoming, "ses_new_child", { parent: "ses_new" })
  incoming.prepare("INSERT INTO todo (session_id, content, status, position, time_created, time_updated) VALUES ('ses_new', 'x', 'pending', 0, ?, ?)").run(T, T)
  incoming.prepare("INSERT INTO task (id, session_id, status, summary, created_at, last_event_at) VALUES ('t1', 'ses_new', 'done', 's', ?, ?)").run(T, T)
  incoming.prepare("INSERT INTO task_event (session_id, task_id, at, kind) VALUES ('ses_new', 't1', ?, 'end')").run(T)
  incoming.close()

  local.exec(`ATTACH DATABASE '${incomingPath}' AS incoming`)
  const rewrite = (s: string) => s.replaceAll("/old/ws", "/new/ws")
  expect(Migration.projectConflicts(local, "incoming", rewrite).map((c) => c.id)).toEqual(["p1"])
  const res = Migration.merge(local, { overwrite: ["ses_over"], rewrite })
  expect(res).toEqual({ imported: 1, overwritten: 1, skipped: 1 })

  // Local-only session survives the in-place project update (no cascade).
  expect(count(local, "SELECT count(*) AS n FROM session WHERE id = 'ses_local_only'")).toBe(1)
  expect((local.prepare("SELECT name FROM project WHERE id = 'p1'").get() as { name: string }).name).toBe("Incoming name")
  // Overwritten: incoming version, old messages gone.
  expect((local.prepare("SELECT title FROM session WHERE id = 'ses_over'").get() as { title: string }).title).toBe("incoming over")
  expect(count(local, "SELECT count(*) AS n FROM message WHERE session_id = 'ses_over'")).toBe(2)
  // Kept: unchanged.
  expect((local.prepare("SELECT title FROM session WHERE id = 'ses_keep'").get() as { title: string }).title).toBe("local keep")
  expect(count(local, "SELECT count(*) AS n FROM message WHERE session_id = 'ses_keep'")).toBe(1)
  // New with descendants and related rows.
  expect(count(local, "SELECT count(*) AS n FROM session WHERE id IN ('ses_new', 'ses_new_child')")).toBe(2)
  expect(count(local, "SELECT count(*) AS n FROM todo WHERE session_id = 'ses_new'")).toBe(1)
  expect(count(local, "SELECT count(*) AS n FROM task_event WHERE session_id = 'ses_new'")).toBe(1)
  // Paths rewritten.
  expect((local.prepare("SELECT directory FROM session WHERE id = 'ses_new'").get() as { directory: string }).directory).toBe("/new/ws/app")
  expect((local.prepare("SELECT data FROM part WHERE session_id = 'ses_new' LIMIT 1").get() as { data: string }).data).toContain("/new/ws/app/a.ts")
  expect((local.prepare("SELECT worktree FROM project WHERE id = 'p1'").get() as { worktree: string }).worktree).toBe("/new/ws/app")
  // Re-running is idempotent: everything is now present locally.
  const again = Migration.merge(local, { overwrite: [] })
  expect(again.imported).toBe(0)
  local.close()
})

// [TP-R14d-01][TP-R14d-02][TP-R29-05]
test("projects: identical ones are not conflicts; kept projects stay local; only written rows are rewritten", () => {
  const { local, incoming, incomingPath } = setup()
  project(local, "p_same", "/new/ws/same", "Same")
  project(incoming, "p_same", "/old/ws/same", "Same")
  project(local, "p_keep", "/new/ws/keep", "Local keep")
  project(incoming, "p_keep", "/old/ws/keep", "Incoming keep")
  project(incoming, "p_new", "/old/ws/fresh", "Fresh")
  session(local, "ses_kept", { project: "p_keep", messages: 1, dir: "/old/ws/keep" })
  session(incoming, "ses_kept", { project: "p_keep", messages: 2, dir: "/old/ws/keep" })
  session(incoming, "ses_a", { project: "p_same" })
  session(incoming, "ses_b", { project: "p_keep" })
  session(incoming, "ses_c", { project: "p_new" })
  incoming.close()
  local.exec(`ATTACH DATABASE '${incomingPath}' AS incoming`)
  const rewrite = (s: string) => s.replaceAll("/old/ws", "/new/ws")
  const conflicts = Migration.projectConflicts(local, "incoming", rewrite)
  expect(conflicts.map((c) => c.id)).toEqual(["p_keep"])
  expect(conflicts[0]).toMatchObject({ localName: "Local keep", incomingName: "Incoming keep", localWorktree: "/new/ws/keep", incomingWorktree: "/new/ws/keep" })

  Migration.merge(local, { overwrite: [], keepProjects: ["p_keep"], rewrite })
  const one = <T>(sql: string) => local.prepare(sql).get() as T
  expect(one<{ name: string }>("SELECT name FROM project WHERE id = 'p_keep'").name).toBe("Local keep")
  expect(one<{ worktree: string }>("SELECT worktree FROM project WHERE id = 'p_new'").worktree).toBe("/new/ws/fresh")
  // Imported session joins the kept project, with rewritten paths.
  expect(one<{ project_id: string; directory: string }>("SELECT project_id, directory FROM session WHERE id = 'ses_b'")).toEqual({ project_id: "p_keep", directory: "/new/ws/app" })
  // The kept (not overwritten) local session is not rewritten.
  expect(one<{ directory: string }>("SELECT directory FROM session WHERE id = 'ses_kept'").directory).toBe("/old/ws/keep")
  expect(one<{ data: string }>("SELECT data FROM part WHERE session_id = 'ses_kept' LIMIT 1").data).toContain("/old/ws/app/a.ts")
  local.close()
})

// [TP-R29-01]
test("scanText visits every path-bearing text column", () => {
  const { local, incoming } = setup()
  incoming.close()
  project(local, "p1", "/repo/a", "A")
  session(local, "ses_1", { dir: "/repo/a/sub" })
  const seen: string[] = []
  Migration.scanText(local, "main", (t) => seen.push(t))
  expect(seen).toContain("/repo/a")
  expect(seen).toContain("/repo/a/sub")
  expect(seen.some((t) => t.includes("/old/ws/app/a.ts"))).toBe(true)
  expect(seen.some((t) => t.includes('"cwd"'))).toBe(true)
  local.close()
})

test("merge refuses data written by a newer engine", () => {
  const { local, incoming, incomingPath } = setup({ local: 100, incoming: 200 })
  incoming.close()
  local.exec(`ATTACH DATABASE '${incomingPath}' AS incoming`)
  expect(() => Migration.merge(local, { overwrite: [] })).toThrow(Migration.MigrationEngineVersionError)
  local.close()
})

test("merge is all-or-nothing: a failure leaves the local database unchanged", () => {
  const { local, incoming, incomingPath } = setup()
  for (const db of [local, incoming]) project(db, "p1", "/ws", "App")
  session(local, "ses_over", { messages: 1 })
  session(incoming, "ses_over", { messages: 2 })
  session(incoming, "ses_new", { messages: 2 })
  incoming.close()
  local.exec("CREATE TRIGGER boom BEFORE INSERT ON part BEGIN SELECT RAISE(ABORT, 'disk full'); END")
  local.exec(`ATTACH DATABASE '${incomingPath}' AS incoming`)
  const before = count(local, "SELECT count(*) AS n FROM message")
  expect(() => Migration.merge(local, { overwrite: ["ses_over"] })).toThrow("disk full")
  expect(count(local, "SELECT count(*) AS n FROM message")).toBe(before)
  expect(count(local, "SELECT count(*) AS n FROM session WHERE id = 'ses_new'")).toBe(0)
  local.close()
})

test("rebindProject moves sessions onto the project this device already uses", () => {
  const { local, incoming } = setup()
  incoming.close()
  project(local, "p_old", "/repo", "Migrated")
  project(local, "p_mine", "/repo", "Mine")
  session(local, "ses_a", { project: "p_old" })
  session(local, "ses_b", { project: "p_mine" })
  expect(Migration.rebindProject(local, "p_old", "p_mine")).toBe(1)
  expect(count(local, "SELECT count(*) AS n FROM session WHERE project_id = 'p_mine'")).toBe(2)
  expect(count(local, "SELECT count(*) AS n FROM project WHERE id = 'p_old'")).toBe(0)
  local.close()
})
