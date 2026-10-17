import { describe, expect, spyOn } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { AppLayer } from "../../src/effect/app-runtime"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { InboxController } from "../../src/inbox"
import { InboxTable, InboxLaneStateTable, InboxSessionEpochTable } from "../../src/inbox/inbox.sql"
import { Database, eq } from "../../src/storage"
import { SyncEvent } from "../../src/sync"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer, TestLLMServer.layer))
const config = (url: string) => ({
  enabled_providers: ["alibaba"],
  provider: { alibaba: { options: { apiKey: "test-key", baseURL: url } } },
  agent: { build: { model: "alibaba/qwen-plus" } },
  checkpoint: { thresholds: [] as string[] },
})

const user = Effect.fn("test.forkUser")(function* (sessionID: SessionID, text: string, queued = true) {
  const sessions = yield* Session.Service
  const message: MessageV2.User = {
    id: MessageID.ascending(), sessionID, agentID: "main", role: "user", time: { created: Date.now() },
    agent: "build", model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
  }
  const part: MessageV2.TextPart = { id: PartID.ascending(), sessionID, messageID: message.id, type: "text", text }
  if (queued) {
    const tq = yield* InboxController.Service
    yield* tq.accept({
      lane: { sessionID, agentID: "main" },
      message,
      parts: [part],
      type: "prompt",
      idempotencyKey: message.id,
    })
    return message
  }
  yield* sessions.updateMessage(message)
  yield* sessions.updatePart(part)
  return message
})

const assistant = Effect.fn("test.forkAssistant")(function* (parent: MessageV2.User, text: string, finish = "stop") {
  const sessions = yield* Session.Service
  const message: MessageV2.Assistant = {
    id: MessageID.ascending(), sessionID: parent.sessionID, agentID: parent.agentID,
    role: "assistant", time: { created: Date.now(), completed: Date.now() }, parentID: parent.id,
    providerID: parent.model.providerID, modelID: parent.model.modelID, mode: "build", agent: "build",
    path: { cwd: "/tmp", root: "/tmp" }, cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish,
  }
  yield* sessions.updateMessage(message)
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID: parent.sessionID, messageID: message.id, type: "text", text })
  return message
})

const admitPrompt = Effect.fn(function* (sessionID: SessionID, messageID: MessageID) {
  const tq = yield* InboxController.Service
  return yield* tq.accept({
    lane: { sessionID, agentID: "main" },
    message: {
      id: messageID, sessionID, agentID: "main", role: "user",
      time: { created: Date.now() },
      agent: "build", model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
    },
    parts: [],
    type: "prompt",
    idempotencyKey: messageID,
  })
})

const receipts = (sessionID: SessionID) => Effect.sync(() => Database.use((db) => db.select().from(InboxTable)
  .where(eq(InboxTable.receiver_session_id, sessionID)).all()))

function byText(messages: MessageV2.WithParts[], text: string) {
  const found = messages.find((message) => message.parts.some((part) => part.type === "text" && part.text === text))
  if (!found) throw new Error(`Missing copied message: ${text}`)
  return found
}

describe("Session.fork queue history", () => {
  it.live(
    "copies no inbox records, keeps queued input hidden until the next run, and never auto-executes it",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const state = yield* SessionRunState.Service
      const tq = yield* InboxController.Service
      const source = yield* sessions.create({ title: "source history" })
      const question = yield* user(source.id, "SOURCE-QUESTION", true)
      const answer = yield* assistant(question, "SOURCE-ANSWER")
      const pending = yield* user(source.id, "SOURCE-PENDING-DO-NOT-EXECUTE", true)
      const lane = { sessionID: source.id, agentID: "main" }
      const receipt = yield* admitPrompt(source.id, question.id)
      yield* tq.claimNext(lane, 1)
      yield* tq.ack(lane, question.id, [{ receiptId: receipt.id, outcome: "success" }], 1)
      const branch = yield* sessions.fork({ sessionID: source.id })
      yield* Effect.addFinalizer(() => prompt.cancel(branch.id))
      const copied = yield* sessions.messages({ sessionID: branch.id })
      byText(copied, "SOURCE-QUESTION")
      byText(copied, "SOURCE-ANSWER")
      byText(copied, "SOURCE-PENDING-DO-NOT-EXECUTE")
      // The fork carries plain history only: no inbox rows, no lane state.
      expect(yield* receipts(branch.id)).toEqual([])
      expect(yield* tq.listAccepted({ sessionID: branch.id, agentID: "main" })).toEqual([])
      expect(yield* Effect.sync(() => Database.use((db) => db.select().from(InboxLaneStateTable)
        .where(eq(InboxLaneStateTable.session_id, branch.id)).all()))).toEqual([])
      yield* tq.reconcileOnBoot(branch.id)
      yield* Effect.sleep("25 millis")
      expect(yield* llm.calls).toBe(0)
      yield* state.assertNotBusy(branch.id)
      yield* llm.text("FORK-ANSWER")
      const result = yield* prompt.prompt({ sessionID: branch.id, agent: "build", parts: [{ type: "text", text: "FORK-FOLLOWUP" }] })
      expect(result.parts.some((part) => part.type === "text" && part.text === "FORK-ANSWER")).toBe(true)
      expect(yield* llm.calls).toBe(1)
      const request = JSON.stringify((yield* llm.inputs)[0].messages)
      expect(request).toContain("SOURCE-QUESTION")
      expect(request).toContain("SOURCE-ANSWER")
      // The copied queued input is plain visible history: the model sees it,
      // and nothing runs it by itself.
      expect(request).toContain("SOURCE-PENDING-DO-NOT-EXECUTE")
      const positions = ["SOURCE-QUESTION", "SOURCE-ANSWER", "SOURCE-PENDING-DO-NOT-EXECUTE", "FORK-FOLLOWUP"]
        .map((text) => request.indexOf(text))
      expect(positions.every((position) => position >= 0)).toBe(true)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    }), { git: true, config }),
    20000,
  )

  it.live(
    "copies messages in rendered order without remapping ids or copying receipts",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tq = yield* InboxController.Service
      const source = yield* sessions.create({ title: "multi-step source" })
      yield* Effect.sync(() => Database.use((db) => db.insert(InboxSessionEpochTable)
        .values({ session_id: source.id, epoch: 7, time_updated: Date.now() }).run()))
      const question = yield* user(source.id, "MULTI-STEP-QUESTION")
      const first = yield* assistant(question, "FIRST-TOOL-STEP", "tool-calls")
      const last = yield* assistant(question, "FINAL-ANSWER")
      const lane = { sessionID: source.id, agentID: "main" }
      const consumed = yield* admitPrompt(source.id, question.id)
      yield* tq.claimNext(lane, 1)
      yield* Effect.sync(() => Database.use((db) => db.update(InboxTable).set({ delivery_message_id: first.id })
        .where(eq(InboxTable.id, consumed.id)).run()))
      yield* tq.ack(lane, question.id, [{ receiptId: consumed.id, outcome: "success" }], 1)
      for (const state of ["accepted", "claimed", "cancelled", "gap"] as const) {
        const pending = yield* user(source.id, `PENDING-${state}`, state !== "gap")
        if (state === "gap") continue
        const receipt = yield* admitPrompt(source.id, pending.id)
        yield* Effect.sync(() => Database.use((db) => db.update(InboxTable).set({ state, outcome: state === "cancelled" ? "never_ran" : null })
          .where(eq(InboxTable.id, receipt.id)).run()))
      }
      const before = yield* receipts(source.id)
      let target: SessionID | undefined
      const snapshots: Array<{ messages: number; parts: number; receipts: number }> = []
      const listener = (event: GlobalEvent) => {
        const sync = event.payload.syncEvent
        if (sync?.type === "session.created.1" && sync.aggregateID !== source.id) target = sync.aggregateID
        if (!target || sync?.aggregateID !== target || !["message.updated.1", "message.part.updated.1"].includes(sync.type)) return
        snapshots.push(Database.use((db) => ({
          messages: db.select().from(MessageTable).where(eq(MessageTable.session_id, target!)).all().length,
          parts: db.select().from(PartTable).where(eq(PartTable.session_id, target!)).all().length,
          receipts: db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, target!)).all().length,
        })))
      }
      GlobalBus.on("event", listener)
      let branch: Session.Info
      try {
        branch = yield* sessions.fork({ sessionID: source.id })
      } finally {
        GlobalBus.off("event", listener)
      }
      const copied = yield* sessions.messages({ sessionID: branch.id })
      // Rendered order: the consumed input sits before the delivery step that
      // first read it; the cancelled input and the one with no inbox record
      // stay in place; the still queued ones (accepted / claimed) follow at the
      // end in acceptance order.
      const order = ["MULTI-STEP-QUESTION", "FIRST-TOOL-STEP", "FINAL-ANSWER",
        "PENDING-cancelled", "PENDING-gap", "PENDING-accepted", "PENDING-claimed"]
      expect(copied.map((message) => message.parts.flatMap((p) => p.type === "text" ? [p.text] : [])).flat()).toEqual(order)
      expect(copied).toHaveLength(7)
      // Message IDs are new (global primary key) but keep their relative order;
      // no inbox row is rewritten and none is copied.
      expect(copied.every((message) => message.info.id < MessageID.ascending())).toBe(true)
      expect(yield* receipts(branch.id)).toEqual([])
      expect(snapshots).toHaveLength(14)
      expect(snapshots.every((snapshot) => snapshot.messages === 7 && snapshot.parts === 7 && snapshot.receipts === 0)).toBe(true)
      yield* tq.reconcileOnBoot(branch.id)
      expect(yield* tq.listAccepted({ sessionID: branch.id, agentID: "main" })).toEqual([])
      expect(yield* llm.calls).toBe(0)
      expect(yield* receipts(source.id)).toEqual(before)
      expect(yield* Effect.sync(() => Database.use((db) => db.select().from(InboxLaneStateTable)
        .where(eq(InboxLaneStateTable.session_id, branch.id)).all()))).toEqual([])
    }), { git: true, config }),
    20000,
  )

  it.live(
    "preserves first-delivery ordering in the next model request and truncates by rendered order",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tq = yield* InboxController.Service
      const prompt = yield* SessionPrompt.Service
      const source = yield* sessions.create({ title: "delivery order source" })
      const firstUser = yield* user(source.id, "FIRST-INPUT")
      const lateUser = yield* user(source.id, "LATE-INPUT")
      const firstStep = yield* assistant(firstUser, "FIRST-STEP", "tool-calls")
      const finalStep = yield* assistant(lateUser, "FINAL-STEP")
      const lane = { sessionID: source.id, agentID: "main" }
      for (const [message, delivery] of [[firstUser, firstStep], [lateUser, finalStep]] as const) {
        const receipt = yield* admitPrompt(source.id, message.id)
        yield* tq.claimNext(lane, 1)
        yield* Effect.sync(() => Database.use((db) => db.update(InboxTable).set({ delivery_message_id: delivery.id })
          .where(eq(InboxTable.id, receipt.id)).run()))
        yield* tq.ack(lane, message.id, [{ receiptId: receipt.id, outcome: "success" }], 1)
      }
      const branch = yield* sessions.fork({ sessionID: source.id })
      yield* Effect.addFinalizer(() => prompt.cancel(branch.id))
      expect(yield* receipts(branch.id)).toEqual([])
      yield* llm.text("FOLLOWUP-ANSWER")
      yield* prompt.prompt({ sessionID: branch.id, agent: "build", parts: [{ type: "text", text: "FOLLOWUP" }] })
      expect(yield* llm.calls).toBe(1)
      const request = JSON.stringify((yield* llm.inputs)[0].messages)
      const positions = ["FIRST-INPUT", "FIRST-STEP", "LATE-INPUT", "FINAL-STEP", "FOLLOWUP"].map((text) => request.indexOf(text))
      expect(positions.every((position) => position >= 0)).toBe(true)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))

      const truncated = yield* sessions.fork({ sessionID: source.id, messageID: finalStep.id })
      const copied = yield* sessions.messages({ sessionID: truncated.id })
      // The cutoff is a rendered-order boundary: every message before the
      // requested one is copied, which includes the input that never got its
      // own delivery step.
      expect(copied.map((message) => message.parts.find((part) => part.type === "text" && "text" in part)?.type === "text"
        ? (message.parts.find((part) => part.type === "text" && "text" in part) as { text: string }).text
        : undefined)).toEqual(["FIRST-INPUT", "FIRST-STEP", "LATE-INPUT"])
      expect(yield* receipts(truncated.id)).toEqual([])
      yield* tq.reconcileOnBoot(truncated.id)
      expect(yield* tq.listAccepted({ sessionID: truncated.id, agentID: "main" })).toEqual([])
      expect(yield* llm.calls).toBe(1)
    }), { git: true, config }),
    20000,
  )

  it.live(
    "rolls back cloned messages and parts and removes the empty target when a part projector fails",
    provideTmpdirServer(() => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const source = yield* sessions.create({ title: "fork rollback source" })
      const question = yield* user(source.id, "ROLLBACK-QUESTION")
      yield* assistant(question, "ROLLBACK-ANSWER")
      const before = yield* sessions.messages({ sessionID: source.id })
      let target: SessionID | undefined
      const clonedEvents: string[] = []
      const listener = (event: GlobalEvent) => {
        const sync = event.payload.syncEvent
        if (sync?.type === "session.created.1" && sync.aggregateID !== source.id) target = sync.aggregateID
        if (target && sync?.aggregateID === target && ["message.updated.1", "message.part.updated.1"].includes(sync.type)) clonedEvents.push(sync.type)
      }
      const run = SyncEvent.run
      let failed = false
      let clonedParts = 0
      const cut = spyOn(SyncEvent, "run").mockImplementation((definition, data, options) => {
        const result = run(definition, data, options)
        if (definition.type === MessageV2.Event.PartUpdated.type && data.sessionID !== source.id && ++clonedParts === 2) {
          // Fork never copies inbox rows, so the clone carries none at any point.
          expect(Database.use((db) => db.select().from(InboxTable)
            .where(eq(InboxTable.receiver_session_id, target!)).all())).toHaveLength(0)
          failed = true
          throw new Error("injected clone part failure")
        }
        return result
      })
      GlobalBus.on("event", listener)
      try {
        const result = yield* sessions.fork({ sessionID: source.id }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(failed).toBe(true)
        expect(target).toBeDefined()
        expect(clonedEvents).toEqual([])
        expect(yield* Effect.sync(() => Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, target!)).get()))).toBeUndefined()
        expect(yield* Effect.sync(() => Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.session_id, target!)).all()))).toEqual([])
        expect(yield* Effect.sync(() => Database.use((db) => db.select().from(PartTable).where(eq(PartTable.session_id, target!)).all()))).toEqual([])
        expect(yield* receipts(target!)).toEqual([])
        expect(yield* sessions.messages({ sessionID: source.id })).toEqual(before)
      } finally {
        cut.mockRestore()
        GlobalBus.off("event", listener)
      }
    }), { git: true, config }),
    20000,
  )
})
