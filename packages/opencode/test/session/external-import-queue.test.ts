import { describe, expect } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { rm } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppLayer } from "../../src/effect/app-runtime"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Global } from "../../src/global"
import { Database, and, eq } from "../../src/storage"
import { ExternalImportTable } from "../../src/session/external-import.sql"
import * as ClaudeImport from "../../src/session/claude-import"
import * as CodexImport from "../../src/session/codex-import"
import * as OpencodeImport from "../../src/session/opencode-import"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, SessionID } from "../../src/session/schema"
import { TurnQueue } from "../../src/turn-queue"
import * as QueueSync from "../../src/turn-queue/sync"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { captureExportData } from "../../src/cli/cmd/export"
import { storeImportedSession } from "../../src/cli/cmd/import"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { schedulerRef } from "../../src/turn-queue/scheduler"

const it = testEffect(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer, TestLLMServer.layer))
const config = (url: string) => ({
  enabled_providers: ["alibaba"], provider: { alibaba: { options: { apiKey: "test-key", baseURL: url } } },
  agent: { build: { model: "alibaba/qwen-plus" } }, checkpoint: { thresholds: [] as string[] },
})

describe("external imported history execution", () => {
  it.live("native import installs accepted and claimed state without starting a process lease", provideTmpdirServer(({ llm }) => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const state = yield* SessionRunState.Service
    const session = yield* sessions.create({ title: "native transport" })
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(), sessionID: session.id, agentID: "main", role: "user", time: { created: Date.now() },
      agent: "build", model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
      queueAdmission: { epoch: 4, ready: true, dispatch: true },
    })
    const queue = QueueSync.capture(session.id)
    queue.epoch = { session_id: session.id, epoch: 4, time_updated: 10 }
    for (const [index, receiptState] of ["accepted", "claimed"].entries()) queue.receipts.push(QueueSync.ReceiptRowSchema.parse({
      id: `native-${session.id}-${index}`, session_id: session.id, agent_id: "main", state: receiptState,
      intent: { kind: "prompt", messageID: message.id }, epoch: 4, run_id: index === 1 ? 77 : null,
      claim_frontier: message.id, consumed: false, suspended: false, outcome: null,
      message_id: null, delivery_message_id: null, error: null, idempotency_key: "", time_created: 1, time_updated: 10,
    }))
    yield* Effect.sync(() => Database.transaction((tx) => QueueSync.applySnapshot(queue, tx)))
    const data = yield* Effect.sync(() => captureExportData(session.id))
    yield* sessions.remove(session.id)
    yield* Effect.sync(() => storeImportedSession(data.info, data.messages, data.queue))
    yield* Effect.yieldNow
    expect(yield* Effect.sync(() => QueueSync.capture(session.id))).toEqual(queue)
    yield* state.assertNotBusy(session.id)
    expect(yield* llm.calls).toBe(0)
  }), { git: true, config }), 20000)

  it.live("OpenCode queue-only import does not kick an accepted shell or create a lease", provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
    const sessionID = SessionID.descending()
    const file = path.join(dir, "queue-only-source.db")
    const src = new SQLite(file)
    try {
      for (const table of ["session", "message", "part", "turn_receipt", "turn_lane_state", "turn_session_epoch", "turn_legacy_bootstrap"]) {
        const schema = Database.Client().$client.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)!
        src.exec(schema.sql)
      }
      src.prepare("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?, 'global', 'queue-only', ?, 'Queue only', '1', 1, 1)").run(sessionID, dir)
      src.prepare("INSERT INTO turn_receipt(id,session_id,agent_id,state,intent,epoch,time_created,time_updated) VALUES(?,?,'main','accepted',?,0,1,1)")
        .run(`shell-${sessionID}`, sessionID, JSON.stringify({ kind: "shell", command: "pwd" }))
    } finally { src.close() }
    const previous = schedulerRef.current
    let kicks = 0
    schedulerRef.current = { kick: () => Effect.sync(() => { kicks++ }) }
    try {
      const result = yield* Effect.promise(() => OpencodeImport.run({ dbPath: file }))
      expect(result.errors).toEqual([])
      expect(result.imported).toBe(1)
      yield* Effect.yieldNow
      expect(kicks).toBe(0)
      yield* (yield* SessionRunState.Service).assertNotBusy(sessionID)
      expect(yield* llm.calls).toBe(0)
      expect(QueueSync.capture(sessionID).receipts[0]).toMatchObject({ state: "accepted", run_id: null, consumed: false })
    } finally { schedulerRef.current = previous }
  }), { git: true, config }), 20000)

  for (const source of ["cc", "codex", "opencode"] as const) {
    it.live(`${source}: boot is inert and the next explicit prompt sees the whole imported history`, provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
      const sourceKey = source === "opencode" ? SessionID.descending() : crypto.randomUUID()
      if (source === "cc" || source === "codex") {
        const file = source === "cc"
          ? path.join(Global.Path.home, ".claude/projects/queue-fixture", `${sourceKey}.jsonl`)
          : path.join(Global.Path.home, ".codex/sessions", `${sourceKey}.jsonl`)
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
        const content = source === "cc" ? [
          { type: "user", cwd: dir, timestamp: "2026-06-01T10:00:00Z", message: { content: "IMPORTED-QUESTION" } },
          { type: "assistant", timestamp: "2026-06-01T10:00:01Z", message: { model: "claude-test", content: [{ type: "text", text: "IMPORTED-ANSWER" }] } },
          { type: "user", timestamp: "2026-06-01T10:00:02Z", message: { content: "IMPORTED-TAIL" } },
        ] : [
          { type: "session_meta", timestamp: "2026-06-01T10:00:00Z", payload: { id: sourceKey, cwd: dir } },
          ...["user", "assistant", "user"].map((role, index) => ({
            type: "response_item", timestamp: `2026-06-01T10:00:0${index}Z`,
            payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: ["IMPORTED-QUESTION", "IMPORTED-ANSWER", "IMPORTED-TAIL"][index] }] },
          })),
        ]
        yield* Effect.promise(() => Bun.write(file, content.map((row) => JSON.stringify(row)).join("\n")))
        const stats = yield* Effect.promise(() => (source === "cc" ? ClaudeImport.run() : CodexImport.run()))
        expect(stats.errors).toEqual([])
        expect(stats.imported).toBe(1)
      } else {
        const file = path.join(dir, "queue-source.db")
        const src = new SQLite(file)
        try {
          src.exec(`CREATE TABLE session(id TEXT, directory TEXT, slug TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
            CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
            CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
          src.prepare("INSERT INTO session VALUES(?, ?, 'fixture', 'Imported history', '1', 1, 1)").run(sourceKey, dir)
          let parent: string | undefined
          for (const [index, role] of ["user", "assistant", "user"].entries()) {
            const id = MessageID.ascending()
            const data = role === "user" ? {
              role, time: { created: index + 1 }, agent: "build", model: { providerID: "alibaba", modelID: "qwen-plus" },
              queueAdmission: { epoch: 0, ready: true, dispatch: true },
            } : {
              role, time: { created: index + 1, completed: index + 1 }, parentID: parent, agent: "build", mode: "build",
              providerID: "alibaba", modelID: "qwen-plus", path: { cwd: dir, root: dir }, cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
            }
            src.prepare("INSERT INTO message VALUES(?, ?, ?, ?, ?)").run(id, sourceKey, index + 1, index + 1, JSON.stringify(data))
            src.prepare("INSERT INTO part VALUES(?, ?, ?, ?, ?, ?)").run(`prt_import_${index}`, id, sourceKey, index + 1, index + 1,
              JSON.stringify({ type: "text", text: ["IMPORTED-QUESTION", "IMPORTED-ANSWER", "IMPORTED-TAIL"][index] }))
            if (role === "user") parent = id
          }
        } finally { src.close() }
        const stats = yield* Effect.promise(() => OpencodeImport.run({ dbPath: file }))
        expect(stats.errors).toEqual([])
        expect(stats.imported).toBe(1)
      }
      const sessionID = yield* Effect.sync(() => Database.use((db) => db.select().from(ExternalImportTable)
        .where(and(eq(ExternalImportTable.source, source), eq(ExternalImportTable.source_key, sourceKey))).get()!.session_id))
      const prompt = yield* SessionPrompt.Service
      const tq = yield* TurnQueue.Service
      const state = yield* SessionRunState.Service
      yield* Effect.addFinalizer(() => prompt.cancel(sessionID))
      const history = yield* Effect.sync(() => QueueSync.capture(sessionID))
      expect(history.receipts).toHaveLength(2)
      expect(history.receipts.every((receipt) => receipt.consumed && receipt.state === "settled" && receipt.outcome === null)).toBe(true)
      yield* tq.reconcileOnBoot(sessionID)
      yield* state.assertNotBusy(sessionID)
      expect(yield* llm.calls).toBe(0)
      expect(yield* tq.listAccepted({ sessionID, agentID: "main" })).toEqual([])
      yield* llm.text("EXPLICIT-ANSWER")
      yield* prompt.prompt({ sessionID, agent: "build", parts: [{ type: "text", text: "EXPLICIT-FOLLOWUP" }] })
      expect(yield* llm.calls).toBe(1)
      const request = JSON.stringify((yield* llm.inputs)[0].messages)
      for (const text of ["IMPORTED-QUESTION", "IMPORTED-ANSWER", "IMPORTED-TAIL", "EXPLICIT-FOLLOWUP"]) expect(request).toContain(text)
      const saved = yield* (yield* Session.Service).messages({ sessionID })
      expect(saved.filter((message) => message.info.role === "user").slice(0, 2).every((message) => !("queueAdmission" in message.info))).toBe(true)
    }), { git: true, config }), 20000)
  }
})
