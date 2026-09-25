import { beforeEach, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import path from "node:path"
import { Database, eq } from "../../src/storage"
import * as OpencodeImport from "../../src/session/opencode-import"
import * as QueueSync from "../../src/turn-queue/sync"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { stopIndexMigration } from "../../src/history/migration"
import { tmpdir } from "../fixture/fixture"

const tables = ["project", "session", "message", "part", "history_fts", "external_import", "turn_receipt", "turn_lane_state", "turn_session_epoch", "turn_legacy_bootstrap"]
const queueTables = ["turn_receipt", "turn_lane_state", "turn_session_epoch", "turn_legacy_bootstrap"]

beforeEach(() => {
  const db = Database.Client()
  stopIndexMigration(db)
  for (const table of [...tables].reverse()) db.$client.exec(`DELETE FROM ${table}`)
  db.$client.exec("UPDATE history_index_migration SET phase = 'done'")
})

function snapshot() {
  return Object.fromEntries(tables.map((table) => [table, Database.Client().$client.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

function insert(db: SQLite, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row)
  db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row) as never[])
}

function source(file: string, queue = true) {
  const src = new SQLite(file)
  for (const table of ["session", "message", "part", ...(queue ? queueTables : [])]) {
    const schema = Database.Client().$client.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)!
    src.exec(schema.sql)
  }
  return src
}

function session(src: SQLite, id = "ses_import_a", extra: Record<string, unknown> = {}) {
  insert(src, "session", { id, project_id: "source-project", slug: "source-slug", directory: "/tmp/import-safety", title: "Source title",
    version: "source-version", time_created: 1, time_updated: 2, ...extra })
}

function message(src: SQLite, sessionID: string, id = "msg_import_a", partID = "prt_import_a", text = "LOCAL") {
  insert(src, "message", { id, session_id: sessionID, agent_id: "main", time_created: 1, time_updated: 2,
    data: JSON.stringify({ role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "test" }, system: text }) })
  insert(src, "part", { id: partID, message_id: id, session_id: sessionID, time_created: 1, time_updated: 2,
    data: JSON.stringify({ type: "text", text }) })
}

for (const native of [false, true]) for (const collision of ["message", "part"]) {
  test(`OpenCode ${native ? "native empty queue" : "legacy"} rejects foreign ${collision} IDs without touching the victim`, async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "collision.db")
    const src = source(file, native)
    try {
      session(src)
      message(src, "ses_import_a")
      expect((await OpencodeImport.run({ dbPath: file })).errors).toEqual([])
      const queue = QueueSync.capture(SessionID.make("ses_import_a"))
      queue.epoch = { session_id: queue.sessionID, epoch: 7, time_updated: 20 }
      queue.lanes = [{ session_id: queue.sessionID, agent_id: "main", consumed_frontier: MessageID.make("msg_import_a"), input_revision: 4, time_updated: 20 }]
      Database.transaction((tx) => QueueSync.applySnapshot(queue, tx))
      const before = snapshot()
      src.exec("UPDATE session SET id = 'ses_import_b'; UPDATE message SET session_id = 'ses_import_b'; UPDATE part SET session_id = 'ses_import_b'")
      src.prepare("UPDATE message SET data = ?").run(JSON.stringify({ role: "user", system: "SOURCE" }))
      src.prepare("UPDATE part SET data = ?").run(JSON.stringify({ type: "text", text: "SOURCE" }))
      if (collision === "message") src.exec("UPDATE part SET id = 'prt_import_b'")
      else src.exec("UPDATE message SET id = 'msg_import_b'; UPDATE part SET message_id = 'msg_import_b'")
      const result = await OpencodeImport.run({ dbPath: file, force: true })
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain("ownership")
      expect(snapshot()).toEqual(before)
    } finally { src.close() }
  })
}

for (const collision of ["message", "part"]) {
  test(`OpenCode resync rejects importer-unowned local ${collision} IDs`, async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "local-collision.db")
    const src = source(file, false)
    try {
      session(src)
      message(src, "ses_import_a")
      expect((await OpencodeImport.run({ dbPath: file })).errors).toEqual([])
      message(Database.Client().$client, "ses_import_a", "msg_local", "prt_local", "LOCAL-CONTINUATION")
      const before = snapshot()
      message(src, "ses_import_a", collision === "message" ? "msg_local" : "msg_new", collision === "part" ? "prt_local" : "prt_new", "SOURCE")
      const result = await OpencodeImport.run({ dbPath: file, force: true })
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain("ownership")
      expect(snapshot()).toEqual(before)
    } finally { src.close() }
  })
}

test("OpenCode refuses a stored ownership list containing another session's messages", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "ownership.db")
  const src = source(file, false)
  try {
    session(src)
    message(src, "ses_import_a")
    expect((await OpencodeImport.run({ dbPath: file })).errors).toEqual([])
    session(Database.Client().$client, "ses_victim", { project_id: "global" })
    message(Database.Client().$client, "ses_victim", "msg_victim", "prt_victim", "VICTIM")
    Database.Client().$client.prepare("UPDATE external_import SET message_ids = ?").run(JSON.stringify(["msg_import_a", "msg_victim"]))
    const before = snapshot()
    const result = await OpencodeImport.run({ dbPath: file, force: true })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("ownership")
    expect(snapshot()).toEqual(before)
  } finally { src.close() }
})

for (const withShell of [false, true]) test(`OpenCode imports an empty native transcript with ${withShell ? "an accepted shell" : "epoch/bootstrap only"}`, async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "queue-only.db")
  const src = source(file)
  try {
    session(src)
    insert(src, "turn_session_epoch", { session_id: "ses_import_a", epoch: 4, time_updated: 2 })
    insert(src, "turn_legacy_bootstrap", { session_id: "ses_import_a", message_ids: "[]", completed: 1, time_updated: 2 })
    if (withShell) insert(src, "turn_receipt", { id: "receipt_shell", session_id: "ses_import_a", agent_id: "main", state: "accepted",
      intent: JSON.stringify({ kind: "shell", command: "pwd" }), epoch: 4, time_created: 1, time_updated: 2 })
    const result = await OpencodeImport.run({ dbPath: file })
    expect(result.errors).toEqual([])
    expect(result.imported).toBe(1)
    const queue = QueueSync.capture(SessionID.make("ses_import_a"))
    if (withShell) expect(queue.receipts[0]).toMatchObject({ state: "accepted", intent: { kind: "shell", command: "pwd" }, run_id: null })
    else expect(queue.receipts).toEqual([])
    expect(queue.epoch?.epoch).toBe(4)
    expect(queue.bootstrap?.completed).toBe(true)
    expect((await OpencodeImport.run({ dbPath: file })).skipped).toBe(1)
  } finally { src.close() }
})

test("OpenCode native session metadata is lossless except project remapping and all fields participate in conflicts", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "metadata.db")
  const src = source(file)
  try {
    session(src, "ses_import_a", {
      workspace_id: "wrk_source", parent_id: "ses_parent", context_from: "ses_context", context_watermark: "msg_context",
      title_source: "generated", title_revision: 9, share_url: "stored-share", summary_additions: 3, summary_deletions: 4, summary_files: 5,
      summary_diffs: JSON.stringify([{ file: "file", patch: "@@ -1 +1 @@\n-a\n+b", additions: 1, deletions: 1 }]),
      revert: JSON.stringify({ messageID: "msg_import_a", snapshot: "snapshot" }),
      permission: JSON.stringify([{ permission: "read", pattern: "*", action: "allow" }]),
      prompt: JSON.stringify({ system: "SECRET_SYSTEM", harness: "default" }), time_compacting: 6, time_archived: 7,
      last_checkpoint_message_id: "msg_checkpoint", auto_worktree_hint_sent: 1,
    })
    message(src, "ses_import_a")
    expect((await OpencodeImport.run({ dbPath: file })).errors).toEqual([])
    const sourceRow = src.query<Record<string, unknown>, []>("SELECT * FROM session").get()!
    const expected: Record<string, unknown> = { ...sourceRow, project_id: "global", auto_worktree_hint_sent: true }
    for (const field of ["summary_diffs", "revert", "permission", "prompt"]) expected[field] = JSON.parse(expected[field] as string)
    const local = () => Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, SessionID.make("ses_import_a"))).get())
    expect(local() as unknown).toEqual(expected)
    expect((await OpencodeImport.run({ dbPath: file })).skipped).toBe(1)
    for (const [field, value] of Object.entries({ slug: "local-slug", workspace_id: "wrk_local",
      prompt: JSON.stringify({ system: "local system", harness: "default" }), context_from: "ses_local", title_revision: 10 })) {
      Database.Client().$client.prepare(`UPDATE session SET ${field} = ? WHERE id = 'ses_import_a'`).run(value)
      const before = snapshot()
      expect(local()?.time_updated).toBe(2)
      const conflict = await OpencodeImport.run({ dbPath: file })
      expect(conflict.errors).toHaveLength(1)
      expect(conflict.errors[0]).toContain("conflicts with existing session")
      expect(snapshot()).toEqual(before)
      if (field !== "title_revision") Database.Client().$client.prepare(`UPDATE session SET ${field} = ? WHERE id = 'ses_import_a'`).run(sourceRow[field] as string | number)
    }
  } finally { src.close() }
})
