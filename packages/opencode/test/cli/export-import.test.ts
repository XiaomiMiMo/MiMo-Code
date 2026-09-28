import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { captureExportData, sanitize } from "../../src/cli/cmd/export"
import * as QueueSync from "../../src/turn-queue/sync"
import { Database, eq } from "../../src/storage"
import { SessionTable, MessageTable, PartTable } from "../../src/session/session.sql"
import { TurnReceiptTable } from "../../src/turn-queue/turn-queue.sql"
import { storeImportedSession } from "../../src/cli/cmd/import"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

const fixture = Effect.fn("test.exportFixture")(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "transport fixture" })
  for (const agentID of ["main", "worker"]) {
    const info: MessageV2.User = {
      id: MessageID.ascending(), sessionID: session.id, agentID, role: "user", time: { created: Date.now() },
      agent: "build", model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    }
    yield* sessions.updateMessage(info)
    yield* sessions.updatePart({
      id: PartID.ascending(), sessionID: session.id, messageID: info.id, type: "text", text: `${agentID} input`,
    })
  }
  return { sessions, session }
})

const queuedFixture = Effect.fn("test.queuedExportFixture")(function* () {
  const { sessions, session } = yield* fixture()
  const data = yield* Effect.sync(() => captureExportData(session.id))
  const main = data.messages[0].info
  const queue = data.queue
  queue.epoch = { session_id: session.id, epoch: 8, time_updated: 100 }
  queue.lanes = ["main", "worker"].map((agent_id) => ({
    session_id: session.id, agent_id, consumed_frontier: data.messages.find((message) => message.info.agentID === agent_id)!.info.id,
    input_revision: 7, time_updated: 100,
  }))
  queue.bootstrap = { session_id: session.id, message_ids: data.messages.map((message) => message.info.id), completed: true, time_updated: 100 }
  const answer = yield* sessions.updateMessage({
    id: MessageID.ascending(), sessionID: session.id, agentID: "main", role: "assistant",
    parentID: main.id, time: { created: Date.now(), completed: Date.now() },
    modelID: ModelID.make("test"), providerID: ProviderID.make("test"), mode: "build", agent: "build",
    path: { cwd: "/tmp", root: "/tmp" }, cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
  })
  for (const [index, state] of ["settled", "accepted", "claimed", "cancelled", "rejected"].entries()) {
    queue.receipts.push(QueueSync.ReceiptRowSchema.parse({
      id: `receipt-${session.id}-${index}`, session_id: session.id, agent_id: index === 1 ? "worker" : "main",
      intent: index === 1 ? { kind: "shell", command: "SECRET-COMMAND", cwd: "SECRET-CWD" } : { kind: "prompt", messageID: main.id },
      state, epoch: index === 3 ? 7 : 8, run_id: index === 2 ? 9 : null, claim_frontier: main.id,
      consumed: index === 0, suspended: index === 1, outcome: index === 0 ? "success" : null,
      message_id: index === 0 ? answer.id : null, delivery_message_id: index === 0 ? answer.id : null,
      error: index === 4 ? "SECRET-ERROR" : null, idempotency_key: `SECRET-KEY-${index}`, time_created: 10 + index, time_updated: 100,
    }))
  }
  yield* Effect.sync(() => Database.transaction((tx) => QueueSync.applySnapshot(queue, tx)))
  return { sessions, session, data: yield* Effect.sync(() => captureExportData(session.id)) }
})

describe("CLI session transport", () => {
  it.live("exports all lanes and repeated identical import is a no-op", provideTmpdirInstance(() => Effect.gen(function* () {
    const { session } = yield* fixture()
    const data = yield* Effect.sync(() => captureExportData(session.id))
    expect(data.messages.map((message) => message.info.agentID)).toEqual(["main", "worker"])
    yield* Effect.sync(() => storeImportedSession(data.info, data.messages, data.queue))
    expect(yield* Effect.sync(() => captureExportData(session.id))).toEqual(data)
  })))

  it.live("rejects divergent transcript and metadata without changing existing data", provideTmpdirInstance(() => Effect.gen(function* () {
    const { session } = yield* fixture()
    const before = yield* Effect.sync(() => captureExportData(session.id))
    const changed = structuredClone(before.messages)
    const part = changed[0].parts[0]
    if (part.type !== "text") throw new Error("Expected fixture text")
    part.text = "must not overwrite"
    expect(() => storeImportedSession(before.info, changed, before.queue)).toThrow("conflicts with existing session")
    expect(() => storeImportedSession({ ...before.info, title: "must not rename" }, before.messages, before.queue)).toThrow("conflicts with existing session")
    expect(yield* Effect.sync(() => captureExportData(session.id))).toEqual(before)
  })))

  it.live("round-trips all durable queue states, epochs, lanes and delivery without normalizing claims", provideTmpdirInstance(() => Effect.gen(function* () {
    const { sessions, session, data } = yield* queuedFixture()
    const transported = JSON.parse(JSON.stringify(data))
    yield* sessions.remove(session.id)
    yield* Effect.sync(() => storeImportedSession(transported.info, transported.messages, transported.queue))
    expect(yield* Effect.sync(() => captureExportData(session.id))).toEqual(data)
    yield* Effect.sync(() => storeImportedSession(transported.info, transported.messages, transported.queue))
    const conflict = structuredClone(data.queue)
    conflict.epoch!.epoch++
    expect(() => storeImportedSession(data.info, data.messages, conflict)).toThrow("conflicts with existing session")
    expect(yield* Effect.sync(() => captureExportData(session.id))).toEqual(data)
  })))

  it.live("sanitizes receipt secrets without dropping queue evidence", provideTmpdirInstance(() => Effect.gen(function* () {
    const { data } = yield* queuedFixture()
    const redacted = sanitize(data)
    expect(JSON.stringify(redacted)).not.toContain("SECRET-")
    expect(redacted.queue.receipts).toHaveLength(5)
    expect(redacted.queue.epoch).toEqual(data.queue.epoch)
    expect(redacted.queue.lanes).toEqual(data.queue.lanes)
    expect(redacted.queue.receipts[0].delivery_message_id).toBe(data.queue.receipts[0].delivery_message_id)
    expect(redacted.queue.receipts[2].run_id).toBe(9)
    expect(QueueSync.SnapshotSchema.safeParse(redacted.queue).success).toBe(true)
  })))

  it.live("sanitizes real tool errors, session prompts and assistant error/result payloads", provideTmpdirInstance(() => Effect.gen(function* () {
    const { sessions, session } = yield* queuedFixture()
    const messages = yield* sessions.messages({ sessionID: session.id })
    const assistant = messages.find((message) => message.info.role === "assistant")!.info
    if (assistant.role !== "assistant") throw new Error("Expected assistant fixture")
    yield* sessions.updateMessage({ ...assistant,
      error: { name: "APIError", data: { message: "SECRET_ASSISTANT_ERROR", isRetryable: false, responseBody: "SECRET_RESPONSE",
        responseHeaders: { authorization: "SECRET_HEADER" }, metadata: { detail: "SECRET_METADATA" } } },
      structured: { result: "SECRET_STRUCTURED" },
      actorResult: { finalText: "SECRET_FINAL", structured: { key: "SECRET_ACTOR_STRUCTURED" }, reportedStatus: "failed",
        reportedSummary: "SECRET_SUMMARY", warnings: ["SECRET_WARNING"] },
    })
    yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: assistant.id, type: "tool", callID: "tool-error", tool: "read",
      state: { status: "error", input: {}, error: "SECRET_TOOL_ERROR", time: { start: 1, end: 2 },
        attachments: [{ id: PartID.ascending(), sessionID: session.id, messageID: assistant.id, type: "file", mime: "text/plain", url: "SECRET_ATTACHMENT" }] } })
    yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: assistant.id, type: "tool", callID: "tool-result", tool: "read",
      state: { status: "completed", input: {}, output: "SECRET_OUTPUT", title: "title", metadata: {}, time: { start: 1, end: 2 },
        providerOutput: { text: "SECRET_PROVIDER_OUTPUT" }, providerMetadata: { key: "SECRET_PROVIDER_METADATA" } } })
    const data = yield* Effect.sync(() => captureExportData(session.id))
    data.info.prompt = { system: "SECRET_SYSTEM", systemMode: "append", harness: "default" }
    const redacted = sanitize(data)
    expect(JSON.stringify(redacted)).not.toContain("SECRET_")
    for (const message of redacted.messages) {
      expect(MessageV2.Info.safeParse(message.info).success).toBe(true)
      for (const part of message.parts) expect(MessageV2.Part.safeParse(part).success).toBe(true)
    }
    expect(redacted.queue).toEqual(sanitize(data).queue)
  })))

  it.live("legacy imports strip markers and explicitly authorize history without claiming success", provideTmpdirInstance(() => Effect.gen(function* () {
    const { sessions, session } = yield* fixture()
    const data = yield* Effect.sync(() => captureExportData(session.id))
    for (const message of data.messages) if (message.info.role === "user") message.info.queueAdmission = { epoch: 8, ready: true, dispatch: true }
    yield* sessions.remove(session.id)
    yield* Effect.sync(() => storeImportedSession(data.info, data.messages))
    const imported = yield* Effect.sync(() => captureExportData(session.id))
    expect(imported.messages.every((message) => !("queueAdmission" in message.info))).toBe(true)
    expect(imported.queue.receipts).toHaveLength(2)
    expect(imported.queue.receipts.every((row) => row.state === "settled" && row.consumed && row.outcome === null && row.run_id === null)).toBe(true)
    expect(imported.queue.lanes).toEqual([])
    expect(imported.queue.bootstrap?.completed).toBe(true)
    yield* Effect.sync(() => storeImportedSession(data.info, data.messages))
    expect(yield* Effect.sync(() => captureExportData(session.id))).toEqual(imported)
  })))

  it.live("receipt failure rolls back the entire imported transcript", provideTmpdirInstance(() => Effect.gen(function* () {
    const { sessions, session, data } = yield* queuedFixture()
    yield* sessions.remove(session.id)
    Database.Client().$client.exec("CREATE TEMP TRIGGER reject_transport_receipt BEFORE INSERT ON turn_receipt BEGIN SELECT RAISE(ABORT, 'receipt failure'); END")
    try {
      expect(() => storeImportedSession(data.info, data.messages, data.queue)).toThrow("receipt failure")
      expect(Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get())).toBeUndefined()
      expect(Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.session_id, session.id)).all())).toEqual([])
      expect(Database.use((db) => db.select().from(PartTable).where(eq(PartTable.session_id, session.id)).all())).toEqual([])
      expect(Database.use((db) => db.select().from(TurnReceiptTable).where(eq(TurnReceiptTable.session_id, session.id)).all())).toEqual([])
    } finally {
      Database.Client().$client.exec("DROP TRIGGER reject_transport_receipt")
    }
  })))

  it.live("rejects mismatched part ownership before writing", provideTmpdirInstance(() => Effect.gen(function* () {
    const { session } = yield* fixture()
    const before = yield* Effect.sync(() => captureExportData(session.id))
    const changed = structuredClone(before.messages)
    changed[0].parts[0].messageID = changed[1].info.id
    expect(() => storeImportedSession(before.info, changed, before.queue)).toThrow("Invalid imported part")
    expect(yield* Effect.sync(() => captureExportData(session.id))).toEqual(before)
  })))
})
