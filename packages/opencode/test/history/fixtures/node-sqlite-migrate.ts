/**
 * Fixture for R7: run real `migrateIndexBatch` under Node with `node:sqlite`.
 * Bundled via `bun build --target=node --external node:sqlite`, then executed by `node`.
 */
import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"
import { migrateIndexBatch, MIGRATION_VERSION } from "../../../src/history/migration.ts"

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const sqlite = new DatabaseSync(":memory:")
sqlite.exec(`
  CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    title_source TEXT NOT NULL DEFAULT 'user',
    title_revision INTEGER NOT NULL DEFAULT 0,
    version TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT 'main',
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE history_fts (
    part_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    tool_name TEXT,
    body TEXT NOT NULL,
    time_created INTEGER NOT NULL
  );
  CREATE TABLE history_index_migration (
    version INTEGER PRIMARY KEY,
    phase TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    fts_end INTEGER NOT NULL,
    part_end INTEGER NOT NULL
  );
`)

const bigText = `needle ${"x".repeat(200_000)}`
sqlite
  .prepare(
    `INSERT INTO session (id, project_id, slug, directory, title, title_source, title_revision, version, time_created, time_updated)
     VALUES (?, ?, 'x', '/tmp', 't', 'user', 0, '1', 1, 1)`,
  )
  .run("ses_n", "proj_n")
sqlite
  .prepare(
    `INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data)
     VALUES (?, 'ses_n', 'main', 1, 1, ?)`,
  )
  .run("msg_n", JSON.stringify({ role: "user" }))
const insertPart = sqlite.prepare(
  `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
   VALUES (?, 'msg_n', 'ses_n', 1, 1, ?)`,
)
insertPart.run("prt_ok", JSON.stringify({ type: "text", text: "nodesqlitehit" }))
insertPart.run("prt_big", JSON.stringify({ type: "text", text: bigText }))
const insertFts = sqlite.prepare(
  `INSERT INTO history_fts (part_id, session_id, message_id, project_id, tool_name, body, time_created)
   VALUES (?, 'ses_n', 'msg_n', 'proj_n', NULL, ?, 1)`,
)
insertFts.run("prt_ok#0", "stalechunk")
insertFts.run("prt_ok#1", "stalechunk")
insertFts.run("ghost#0", "orphan")
insertFts.run("prt_big", "y".repeat(200_000))
const ftsEnd = (sqlite.prepare("SELECT MAX(rowid) AS n FROM history_fts").get() as { n: number }).n
const partEnd = (sqlite.prepare("SELECT MAX(rowid) AS n FROM part").get() as { n: number }).n
sqlite
  .prepare(
    `INSERT INTO history_index_migration (version, phase, cursor, fts_end, part_end)
     VALUES (?, 'clean', 0, ?, ?)`,
  )
  .run(MIGRATION_VERSION, ftsEnd, partEnd)

const db = drizzle({ client: sqlite as never }) as never as Parameters<typeof migrateIndexBatch>[0]
let guard = 0
while (migrateIndexBatch(db)) {
  if (++guard > 50) fail("migrateIndexBatch did not terminate on node:sqlite")
}

const phase = (
  sqlite.prepare("SELECT phase FROM history_index_migration WHERE version=?").get(MIGRATION_VERSION) as {
    phase: string
  }
).phase
if (phase !== "done") fail(`expected phase done, got ${phase}`)

const rows = sqlite.prepare("SELECT part_id, body FROM history_fts ORDER BY part_id").all() as Array<{
  part_id: string
  body: string
}>
const ids = rows.map((r) => r.part_id).sort()
if (JSON.stringify(ids) !== JSON.stringify(["prt_big", "prt_ok"])) fail(`unexpected part ids: ${ids.join(",")}`)
const ok = rows.find((r) => r.part_id === "prt_ok")!
if (!ok.body.includes("nodesqlitehit")) fail("repair missed original text")
if (ok.body.includes("stalechunk")) fail("clean left stale chunk body")
const big = rows.find((r) => r.part_id === "prt_big")!
if (!big.body.includes("needle")) fail("repair lost needle marker")
if (big.body.includes("y".repeat(50))) fail("repair left oversized body")
if (Buffer.byteLength(big.body, "utf-8") > 50 * 1024) fail("repaired body exceeds tool-result budget")
sqlite.close()
console.log(JSON.stringify({ ok: true, phase, ids }))
