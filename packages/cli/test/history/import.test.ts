import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { rm } from "node:fs/promises"
import path from "node:path"
import { Database, eq } from "../../src/storage"
import { Global } from "../../src/global"
import * as ClaudeImport from "../../src/session/claude-import"
import * as CodexImport from "../../src/session/codex-import"
import * as OpencodeImport from "../../src/session/opencode-import"
import type { MessageV2 } from "../../src/session/message-v2"
import { HistoryFtsTable, HistoryIndexMigrationTable } from "../../src/history/fts.sql"
import { ExternalImportTable } from "../../src/session/external-import.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { stopIndexMigration } from "../../src/history/migration"
import { tmpdir } from "../fixture/fixture"
import * as QueueSync from "../../src/inbox/sync"
import { MessageID, SessionID } from "../../src/session/schema"

const files: string[] = []
beforeEach(() => {
  const db = Database.Client()
  stopIndexMigration(db)
  db.delete(ExternalImportTable).run()
  db.delete(PartTable).run()
  db.delete(MessageTable).run()
  db.delete(SessionTable).run()
  db.delete(ProjectTable).run()
  db.delete(HistoryFtsTable).run()
  db.update(HistoryIndexMigrationTable).set({ phase: "done" }).run()
})
afterEach(async () => {
  Database.Client().$client.exec("DROP TRIGGER IF EXISTS reject_cli_index; DROP TRIGGER IF EXISTS reject_index; DROP TRIGGER IF EXISTS reject_import_mapping")
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })))
})
function hits(word: string) {
  return Database.Client()
    .$client.prepare("SELECT count(*) AS n FROM history_fts_idx WHERE history_fts_idx MATCH ?")
    .get(word)
}

function nativeContinuation(sessionID: SessionID) {
  const id = MessageID.ascending()
  Database.Client().$client.prepare("INSERT INTO message(id, session_id, agent_id, time_created, time_updated, data) VALUES(?, ?, 'main', 1, 1, ?)")
    .run(id, sessionID, JSON.stringify({ role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "test" } }))
  const snapshot = QueueSync.capture(sessionID)
  snapshot.epoch = { session_id: sessionID, epoch: 7, time_updated: 10 }
  snapshot.lanes = [{ session_id: sessionID, agent_id: "main", consumed_frontier: id, input_revision: 9, time_updated: 10 }]
  const receipt = QueueSync.ReceiptRowSchema.parse({
    id: `native-${id}`, receiver_session_id: sessionID, receiver_actor_id: "main", state: "settled",
    sender_session_id: null, sender_actor_id: null, type: "prompt", content: null, input_message_id: id,
    epoch: 7, run_id: 4, claim_frontier: id, consumed: true, outcome: "success",
    delivery_message_id: null, error: null, idempotency_key: id, created_at: 1, time_updated: 10,
  })
  snapshot.receipts.push(receipt)
  Database.transaction((tx) => QueueSync.applySnapshot(snapshot, tx))
  return { id, receipt, epoch: snapshot.epoch, lanes: snapshot.lanes }
}

function importSnapshot(sessionID: SessionID) {
  const db = Database.Client()
  return {
    sessions: db.select().from(SessionTable).orderBy(SessionTable.id).all(),
    projects: db.select().from(ProjectTable).orderBy(ProjectTable.id).all(),
    messages: db.select().from(MessageTable).orderBy(MessageTable.id).all(),
    parts: db.select().from(PartTable).orderBy(PartTable.id).all(),
    fts: db.select().from(HistoryFtsTable).all(),
    queue: QueueSync.capture(sessionID),
    mappings: db.select().from(ExternalImportTable).all(),
  }
}

async function rejectMissingOwnership(sessionID: SessionID, run: () => Promise<{ errors: string[]; imported: number; resynced: number }>) {
  const db = Database.Client()
  const original = db.select().from(ExternalImportTable).where(eq(ExternalImportTable.session_id, sessionID)).get()!
  db.update(ExternalImportTable).set({ message_ids: null }).where(eq(ExternalImportTable.session_id, sessionID)).run()
  const missingSessionID = SessionID.descending()
  try {
    for (const mappedID of [sessionID, missingSessionID]) {
      db.update(ExternalImportTable).set({ session_id: mappedID }).run()
      const before = importSnapshot(sessionID)
      const rejected = await run()
      expect(rejected.errors).toHaveLength(1)
      expect(rejected.errors[0]).toContain("imported message ownership is missing")
      expect(rejected.imported).toBe(0)
      expect(rejected.resynced).toBe(0)
      expect(importSnapshot(sessionID)).toEqual(before)
    }
  } finally {
    db.update(ExternalImportTable).set({ session_id: original.session_id, message_ids: original.message_ids }).run()
  }
}

async function acceptEmptyOwnership(sessionID: SessionID, run: () => Promise<{ errors: string[]; resynced: number }>) {
  Database.Client().update(ExternalImportTable).set({ message_ids: [] }).where(eq(ExternalImportTable.session_id, sessionID)).run()
  const before = importSnapshot(sessionID)
  const result = await run()
  expect(result.errors).toEqual([])
  expect(result.resynced).toBe(1)
  const after = importSnapshot(sessionID)
  const oldMessages = new Set(before.messages.map((message) => message.id))
  const oldParts = new Set<string>(before.parts.map((part) => part.id))
  const oldReceipts = new Set(before.queue.receipts.map((receipt) => receipt.id))
  expect(after.messages.filter((message) => oldMessages.has(message.id))).toEqual(before.messages)
  expect(after.parts.filter((part) => oldParts.has(part.id))).toEqual(before.parts)
  expect(after.fts.filter((row) => oldParts.has(row.part_id))).toEqual(before.fts)
  expect(after.queue.receipts.filter((receipt) => oldReceipts.has(receipt.id))).toEqual(before.queue.receipts)
  expect(after.queue.epoch).toEqual(before.queue.epoch)
  expect(after.queue.lanes).toEqual(before.queue.lanes)
  expect(after.sessions[0].title).toBe(before.sessions[0].title)
  expect(after.mappings[0].message_ids!.length).toBeGreaterThan(0)
  expect(after.mappings[0].message_ids!.every((id) => !oldMessages.has(id))).toBe(true)
}

// Imports remain searchable after the migration has finished.
for (const source of ["claude", "codex"] as const) {
  test(`${source}: imported and resynchronized text is searchable without bootstrap`, async () => {
    const file =
      source === "claude"
        ? path.join(Global.Path.home, ".claude/projects/history-fixture/history-fixture.jsonl")
        : path.join(Global.Path.home, ".codex/sessions/history-fixture.jsonl")
    files.push(file)
    const write = async (text: string) => {
      const content =
        source === "claude"
          ? [
              {
                type: "user",
                uuid: "history-fixture",
                cwd: "/tmp/example",
                timestamp: "2026-06-01T10:00:00Z",
                message: { role: "user", content: text },
              },
            ]
          : [
              { type: "session_meta", payload: { id: "history-fixture", cwd: "/tmp/example" } },
              {
                type: "response_item",
                timestamp: "2026-06-01T10:00:00Z",
                payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
              },
            ]
      await Bun.write(file, content.map((row) => JSON.stringify(row)).join("\n"))
    }
    const run = source === "claude" ? ClaudeImport.run : CodexImport.run
    await write("originalneedle")
    Database.Client().$client.exec(
      "CREATE TRIGGER reject_index BEFORE INSERT ON history_fts BEGIN SELECT RAISE(ABORT, 'index failure'); END",
    )
    const failed = await run({ force: true })
    expect(failed.errors).toHaveLength(1)
    expect(Database.Client().select().from(PartTable).all()).toHaveLength(0)
    Database.Client().$client.exec("DROP TRIGGER reject_index")
    const first = await run({ force: true })
    expect(first.errors).toEqual([])
    expect(first.imported).toBe(1)
    expect(hits("originalneedle")).toEqual({ n: 1 })
    const sessionID = Database.Client().select().from(ExternalImportTable).get()!.session_id
    const originalQueue = QueueSync.capture(sessionID)
    expect(originalQueue.receipts).toHaveLength(1)
    expect(originalQueue.receipts[0]).toMatchObject({ state: "settled", consumed: true, outcome: null })
    const native = nativeContinuation(sessionID)
    await rejectMissingOwnership(sessionID, () => run({ force: true }))
    await write("replacementneedle")
    const beforeResync = QueueSync.capture(sessionID)
    Database.Client().$client.exec("CREATE TEMP TRIGGER reject_import_mapping BEFORE UPDATE ON external_import BEGIN SELECT RAISE(ABORT, 'mapping failure'); END")
    try {
      const failedResync = await run({ force: true })
      expect(failedResync.errors).toHaveLength(1)
      expect(QueueSync.capture(sessionID)).toEqual(beforeResync)
      expect(hits("originalneedle")).toEqual({ n: 1 })
      expect(hits("replacementneedle")).toEqual({ n: 0 })
    } finally {
      Database.Client().$client.exec("DROP TRIGGER reject_import_mapping")
    }
    const second = await run({ force: true })
    expect(second.errors).toEqual([])
    expect(second.resynced).toBe(1)
    expect(hits("originalneedle")).toEqual({ n: 0 })
    expect(hits("replacementneedle")).toEqual({ n: 1 })
    const nextQueue = QueueSync.capture(sessionID)
    expect(nextQueue.receipts).toHaveLength(2)
    expect(nextQueue.receipts.find((row) => row.id === originalQueue.receipts[0].id)).toBeUndefined()
    expect(nextQueue.receipts.find((row) => row.id === native.receipt.id)).toEqual(native.receipt)
    expect(nextQueue.epoch).toEqual(native.epoch)
    expect(nextQueue.lanes).toEqual(native.lanes)
    expect(Database.Client().$client.prepare("SELECT id FROM message WHERE id = ?").get(native.id)).toEqual({ id: native.id })
    expect(Database.Client().select().from(HistoryIndexMigrationTable).get()?.phase).toBe("done")
    await write("emptyownershipneedle")
    await acceptEmptyOwnership(sessionID, () => run({ force: true }))
    expect(hits("replacementneedle")).toEqual({ n: 1 })
    expect(hits("emptyownershipneedle")).toEqual({ n: 1 })
  })
}

// [TP-SR-R21-32]
test("OpenCode: source edits maintain search and preserve locally continued messages with executed tools", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "source.db")
  const src = new SQLite(file)
  try {
    src.exec(`CREATE TABLE session(id TEXT, directory TEXT, slug TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES('ses_import', '/tmp/example', 'example', 'Example', '1', 1, 1);
      INSERT INTO message VALUES('msg_import', 'ses_import', 1, 1, '{"role":"user","queueAdmission":{"epoch":0,"ready":true,"dispatch":true}}');
      INSERT INTO part VALUES('part_import', 'msg_import', 'ses_import', 1, 1, '{"type":"text","text":"originalneedle"}');`)
    const first = await OpencodeImport.run({ dbPath: file })
    expect(first.errors).toEqual([])
    expect(first.imported).toBe(1)
    expect(hits("originalneedle")).toEqual({ n: 1 })
    const sessionID = Database.Client().select().from(ExternalImportTable).get()!.session_id
    expect(Database.Client().select().from(MessageTable).get()!.data).not.toHaveProperty("queueAdmission")
    expect(QueueSync.capture(sessionID).receipts[0]).toMatchObject({ state: "settled", consumed: true, outcome: null })
    const native = nativeContinuation(sessionID)
    await rejectMissingOwnership(sessionID, () => OpencodeImport.run({ dbPath: file, force: true }))
    const db = Database.Client()
    const tool = { type: "tool", tool: "bash", callID: "call-local", execution: "started",
      state: { status: "completed", input: { command: "pwd" }, output: "/tmp/example", title: "Local continuation",
        metadata: { exit: 0 }, time: { start: 3, end: 4 } }, metadata: { local: true },
    } satisfies Omit<MessageV2.ToolPart, "id" | "sessionID" | "messageID">
    const insertMessage = db.$client.prepare("INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data) VALUES (?, 'ses_import', 'main', 3, 4, ?)")
    insertMessage.run("msg_local_user", JSON.stringify({ role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: 3 } }))
    insertMessage.run("msg_local_assistant", JSON.stringify({ role: "assistant", parentID: "msg_local_user", time: { created: 3, completed: 4 } }))
    const insertPart = db.$client.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, 'ses_import', 3, 4, ?)")
    insertPart.run("prt_local_user", "msg_local_user", JSON.stringify({ type: "text", text: "Continue locally" }))
    insertPart.run("prt_local_tool", "msg_local_assistant", JSON.stringify(tool))
    const localHistory = () => ({
      messages: db.select().from(MessageTable).all().filter(row => row.id.startsWith("msg_local_")),
      parts: db.select().from(PartTable).all().filter(row => row.id.startsWith("prt_local_")),
    })
    const before = localHistory()
    expect(before.messages).toHaveLength(2)
    expect(before.parts).toHaveLength(2)
    expect(db.select().from(ExternalImportTable).get()?.message_ids?.map(String)).toEqual(["msg_import"])
    src.exec(`UPDATE session SET time_updated = 2;
      UPDATE part SET data = '{"type":"text","text":"replacementneedle"}';`)
    const second = await OpencodeImport.run({ dbPath: file })
    expect(second.errors).toEqual([])
    expect(second.resynced).toBe(1)
    expect(hits("originalneedle")).toEqual({ n: 0 })
    expect(hits("replacementneedle")).toEqual({ n: 1 })
    expect(localHistory()).toEqual(before)
    expect(db.select().from(PartTable).all().find(row => row.id === "prt_local_tool")?.data).toEqual(tool)
    expect(db.select().from(ExternalImportTable).get()).toMatchObject({ message_ids: ["msg_import"], source_mtime: 2 })
    const nextQueue = QueueSync.capture(sessionID)
    expect(nextQueue.receipts).toHaveLength(2)
    expect(nextQueue.receipts.find((row) => row.id === native.receipt.id)).toEqual(native.receipt)
    expect(nextQueue.epoch).toEqual(native.epoch)
    expect(nextQueue.lanes).toEqual(native.lanes)
    expect(Database.Client().$client.prepare("SELECT id FROM message WHERE id = ?").get(native.id)).toEqual({ id: native.id })
  } finally {
    src.close()
  }
})

// [TP-SR-R21-32]
test("OpenCode reimport cannot erase execution proof through message replacement or tool type changes", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "proof-source.db")
  const src = new SQLite(file)
  try {
    src.exec(`CREATE TABLE session(id TEXT, directory TEXT, slug TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES('ses_proof', '/tmp/example', 'example', 'Example', '1', 1, 1);
      INSERT INTO message VALUES('msg_proof', 'ses_proof', 1, 1, '{"role":"assistant"}');`)
    const tool = { type: "tool", tool: "write", callID: "call-proof", execution: "not-started",
      state: { status: "error", input: {}, inputComplete: false, error: "interrupted", time: { start: 1, end: 2 } } } satisfies Omit<MessageV2.ToolPart, "id" | "sessionID" | "messageID">
    src.prepare("INSERT INTO part VALUES('prt_proof', 'msg_proof', 'ses_proof', 1, 1, ?)").run(JSON.stringify(tool))
    expect((await OpencodeImport.run({ dbPath: file })).errors).toEqual([])
    const db = Database.Client()
    expect(db.select().from(PartTable).get()?.data).not.toHaveProperty("execution")
    const completed = { ...tool, execution: "started", metadata: { providerExecuted: true },
      state: { status: "completed", input: {}, output: "original result", title: "done", metadata: {}, time: { start: 1, end: 2 } } } satisfies Omit<MessageV2.ToolPart, "id" | "sessionID" | "messageID">
    db.$client.prepare("UPDATE part SET data = ? WHERE id = 'prt_proof'").run(JSON.stringify(completed))
    src.exec("UPDATE session SET time_updated = 2")
    expect((await OpencodeImport.run({ dbPath: file })).errors).toEqual([])
    expect(db.select().from(PartTable).get()?.data).toEqual(completed)
    src.exec(`UPDATE session SET time_updated = 3; UPDATE part SET data = '{"type":"text","text":"replacement"}'`)
    expect((await OpencodeImport.run({ dbPath: file })).errors).toHaveLength(1)
    expect(db.select().from(PartTable).get()?.data).toEqual(completed)
    src.exec("UPDATE session SET time_updated = 4; DELETE FROM part")
    expect((await OpencodeImport.run({ dbPath: file })).errors).toHaveLength(1)
    expect(db.select().from(PartTable).get()?.data).toEqual(completed)
  } finally {
    src.close()
  }
})

test("OpenCode queue snapshots preserve claims and reject queue-only divergence without skipping it", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "native-source.db")
  const src = new SQLite(file)
  try {
    src.exec(`CREATE TABLE session(id TEXT, directory TEXT, slug TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message(id TEXT, session_id TEXT, agent_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE inbox_session_epoch(session_id TEXT, epoch INTEGER, time_updated INTEGER);
      CREATE TABLE inbox_lane_state(session_id TEXT, agent_id TEXT, consumed_frontier TEXT, input_revision INTEGER, time_updated INTEGER);
      CREATE TABLE inbox(id TEXT, receiver_session_id TEXT, receiver_actor_id TEXT, sender_session_id TEXT, sender_actor_id TEXT,
        type TEXT, content TEXT, input_message_id TEXT, state TEXT, epoch INTEGER, run_id INTEGER,
        claim_frontier TEXT, consumed INTEGER, outcome TEXT, delivery_message_id TEXT,
        error TEXT, idempotency_key TEXT, created_at INTEGER, time_updated INTEGER);
      INSERT INTO session VALUES('ses_native_import', '/tmp/example', 'example', 'Example', '1', 1, 1);
      INSERT INTO message VALUES('msg_native_import', 'ses_native_import', 'worker', 1, 1, '{"role":"user"}');
      INSERT INTO part VALUES('part_native_import', 'msg_native_import', 'ses_native_import', 1, 1, '{"type":"text","text":"nativequeue"}');
      INSERT INTO inbox_session_epoch VALUES('ses_native_import', 6, 10);
      INSERT INTO inbox_lane_state VALUES('ses_native_import', 'worker', 'msg_native_import', 9, 10);
      INSERT INTO inbox VALUES('native-import-receipt', 'ses_native_import', 'worker', NULL, NULL, 'prompt', NULL,
        'msg_native_import', 'claimed', 6, 99, 'msg_native_import', 0, NULL, 'msg_native_import', NULL, 'native-key', 1, 10);`)
    const first = await OpencodeImport.run({ dbPath: file })
    expect(first.errors).toEqual([])
    expect(first.imported).toBe(1)
    const sessionID = Database.Client().select().from(ExternalImportTable).get()!.session_id
    const queue = QueueSync.capture(sessionID)
    expect(queue.epoch?.epoch).toBe(6)
    expect(queue.lanes[0].input_revision).toBe(9)
    expect(queue.receipts[0]).toMatchObject({ state: "claimed", run_id: 99, delivery_message_id: "msg_native_import", consumed: false })
    expect(Database.Client().select().from(MessageTable).get()!.agent_id).toBe("worker")
    expect(Database.Client().select().from(MessageTable).get()!.data).not.toHaveProperty("queueAdmission")
    expect((await OpencodeImport.run({ dbPath: file })).skipped).toBe(1)
    src.exec("UPDATE inbox SET state = 'cancelled', outcome = 'never_ran'")
    const conflict = await OpencodeImport.run({ dbPath: file })
    expect(conflict.errors).toHaveLength(1)
    expect(conflict.errors[0]).toContain("conflicts with existing session")
    expect(QueueSync.capture(sessionID)).toEqual(queue)
  } finally {
    src.close()
  }
})

test("CLI import writes searchable parts atomically after migration completion", async () => {
  const { storeImportedSession } = await import("../../src/cli/cmd/import")
  const { Session } = await import("../../src/session")
  const { ProjectID } = await import("../../src/project/schema")
  const db = Database.Client()
  db.insert(ProjectTable)
    .values({ id: ProjectID.global, worktree: "/tmp/example", sandboxes: [], time_created: 1, time_updated: 1 })
    .run()
  const info = Session.Info.parse({
    id: "ses_cli",
    slug: "example",
    projectID: "global",
    directory: "/tmp/example",
    title: "Imported",
    titleSource: "user",
    titleRevision: 0,
    version: "1",
    time: { created: 1, updated: 1 },
  })
  const messages = [
    {
      info: {
        id: "msg_cli",
        sessionID: "ses_cli",
        role: "user",
        agent: "main",
        model: { providerID: "test", modelID: "model" },
        time: { created: 1 },
      },
      parts: [{ id: "prt_cli", sessionID: "ses_cli", messageID: "msg_cli", type: "text", text: "clineedle" }],
    },
  ]
  db.$client.exec(
    "CREATE TRIGGER reject_cli_index BEFORE INSERT ON history_fts BEGIN SELECT RAISE(ABORT, 'index failure'); END",
  )
  expect(() => storeImportedSession(info, messages)).toThrow("index failure")
  expect(db.select().from(PartTable).all()).toHaveLength(0)
  expect(db.select().from(MessageTable).all()).toHaveLength(0)
  db.$client.exec("DROP TRIGGER reject_cli_index")
  storeImportedSession(info, messages)
  expect(hits("clineedle")).toEqual({ n: 1 })
  expect(db.select().from(HistoryIndexMigrationTable).get()?.phase).toBe("done")
})
