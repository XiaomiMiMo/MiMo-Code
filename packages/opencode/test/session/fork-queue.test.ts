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
import { TurnQueue } from "../../src/turn-queue"
import { TurnLaneStateTable, TurnLegacyBootstrapTable, TurnReceiptTable, TurnSessionEpochTable } from "../../src/turn-queue/turn-queue.sql"
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
  if (queued) return yield* sessions.persistQueuedUser({ message, parts: [part], dispatch: true })
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

const receipts = (sessionID: SessionID) => Effect.sync(() => Database.use((db) => db.select().from(TurnReceiptTable)
  .where(eq(TurnReceiptTable.session_id, sessionID)).all()))

function byText(messages: MessageV2.WithParts[], text: string) {
  const found = messages.find((message) => message.parts.some((part) => part.type === "text" && part.text === text))
  if (!found) throw new Error(`Missing copied message: ${text}`)
  return found
}

describe("Session.fork queue history", () => {
  for (const legacy of [false, true]) {
    it.live(
      `boot does not execute copied ${legacy ? "frozen legacy" : "admitted"} history and a new prompt sees its answered context`,
      provideTmpdirServer(({ llm }) => Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const state = yield* SessionRunState.Service
        const tq = yield* TurnQueue.Service
        const source = yield* sessions.create({ title: "source history" })
        const question = yield* user(source.id, "SOURCE-QUESTION", !legacy)
        const answer = yield* assistant(question, "SOURCE-ANSWER")
        const pending = yield* user(source.id, "SOURCE-PENDING-DO-NOT-EXECUTE", !legacy)
        if (legacy) {
          yield* Effect.sync(() => Database.use((db) => db.insert(TurnLegacyBootstrapTable).values({
            session_id: source.id, message_ids: [question.id, answer.id, pending.id], completed: false, time_updated: Date.now(),
          }).run()))
        } else {
          const lane = { sessionID: source.id, agentID: "main" }
          const receipt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: question.id } })
          yield* tq.claimNext(lane, 1)
          yield* tq.ack(lane, question.id, [{ receiptId: receipt.id, outcome: "success", messageId: answer.id }], 1)
        }
        const branch = yield* sessions.fork({ sessionID: source.id })
        yield* Effect.addFinalizer(() => prompt.cancel(branch.id))
        const copied = yield* sessions.messages({ sessionID: branch.id })
        const copiedQuestion = byText(copied, "SOURCE-QUESTION")
        const copiedPending = byText(copied, "SOURCE-PENDING-DO-NOT-EXECUTE")
        expect(copied.filter((message) => message.info.role === "user").every((message) => !("queueAdmission" in message.info))).toBe(true)
        const history = yield* receipts(branch.id)
        expect(history.find((row) => row.intent.messageID === copiedQuestion.info.id)?.consumed).toBe(true)
        expect(history.find((row) => row.intent.messageID === copiedPending.info.id)?.state).toBe("cancelled")
        yield* tq.reconcileOnBoot(branch.id)
        yield* Effect.sleep("25 millis")
        expect(yield* llm.calls).toBe(0)
        expect(yield* tq.listAccepted({ sessionID: branch.id, agentID: "main" })).toEqual([])
        yield* state.assertNotBusy(branch.id)
        yield* llm.text("FORK-ANSWER")
        const result = yield* prompt.prompt({ sessionID: branch.id, agent: "build", parts: [{ type: "text", text: "FORK-FOLLOWUP" }] })
        expect(result.parts.some((part) => part.type === "text" && part.text === "FORK-ANSWER")).toBe(true)
        expect(yield* llm.calls).toBe(1)
        const request = JSON.stringify((yield* llm.inputs)[0].messages)
        expect(request).toContain("SOURCE-QUESTION")
        expect(request).toContain("SOURCE-ANSWER")
        expect(request).toContain("FORK-FOLLOWUP")
        expect(request).not.toContain("SOURCE-PENDING-DO-NOT-EXECUTE")
        if (legacy) {
          expect(yield* receipts(source.id)).toEqual([])
          expect(yield* Effect.sync(() => Database.use((db) => db.select().from(TurnLegacyBootstrapTable)
            .where(eq(TurnLegacyBootstrapTable.session_id, source.id)).get()?.completed))).toBe(false)
        }
      }), { git: true, config }),
      20000,
    )
  }

  it.live(
    "remaps result and first delivery across epochs while pending work stays terminal and clone events see a complete snapshot",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tq = yield* TurnQueue.Service
      const source = yield* sessions.create({ title: "multi-step source" })
      yield* Effect.sync(() => Database.use((db) => db.insert(TurnSessionEpochTable)
        .values({ session_id: source.id, epoch: 7, time_updated: Date.now() }).run()))
      const question = yield* user(source.id, "MULTI-STEP-QUESTION")
      const first = yield* assistant(question, "FIRST-TOOL-STEP", "tool-calls")
      const last = yield* assistant(question, "FINAL-ANSWER")
      const lane = { sessionID: source.id, agentID: "main" }
      const consumed = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: question.id } })
      yield* tq.claimNext(lane, 1)
      yield* Effect.sync(() => Database.use((db) => db.update(TurnReceiptTable).set({ delivery_message_id: first.id })
        .where(eq(TurnReceiptTable.id, consumed.id)).run()))
      yield* tq.ack(lane, question.id, [{ receiptId: consumed.id, outcome: "success", messageId: last.id }], 1)
      for (const state of ["accepted", "claimed", "cancelled", "gap"] as const) {
        const pending = yield* user(source.id, `PENDING-${state}`)
        if (state === "gap") continue
        const receipt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: pending.id } })
        yield* Effect.sync(() => Database.use((db) => db.update(TurnReceiptTable).set({ state, outcome: state === "cancelled" ? "never_ran" : null })
          .where(eq(TurnReceiptTable.id, receipt.id)).run()))
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
          receipts: db.select().from(TurnReceiptTable).where(eq(TurnReceiptTable.session_id, target!)).all().length,
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
      const history = yield* receipts(branch.id)
      const mapped = history.find((row) => row.consumed)!
      expect(mapped.id).not.toBe(consumed.id)
      expect(mapped.epoch).toBe(0)
      expect(mapped.intent.messageID).toBe(byText(copied, "MULTI-STEP-QUESTION").info.id)
      expect(mapped.message_id).toBe(byText(copied, "FINAL-ANSWER").info.id)
      expect(mapped.delivery_message_id).toBe(byText(copied, "FIRST-TOOL-STEP").info.id)
      expect(mapped.run_id).toBeNull()
      expect(history.filter((row) => !row.consumed)).toHaveLength(4)
      expect(history.filter((row) => !row.consumed).every((row) => row.state === "cancelled" && row.outcome === "never_ran")).toBe(true)
      expect(copied.filter((message) => message.info.role === "assistant").every((message) =>
        message.info.role === "assistant" && message.info.parentID === mapped.intent.messageID)).toBe(true)
      expect(snapshots).toHaveLength(14)
      expect(snapshots.every((snapshot) => snapshot.messages === 7 && snapshot.parts === 7 && snapshot.receipts === 5)).toBe(true)
      yield* tq.reconcileOnBoot(branch.id)
      expect(yield* tq.listAccepted({ sessionID: branch.id, agentID: "main" })).toEqual([])
      expect(yield* llm.calls).toBe(0)
      expect(yield* receipts(source.id)).toEqual(before)
      expect(yield* Effect.sync(() => Database.use((db) => db.select().from(TurnLaneStateTable)
        .where(eq(TurnLaneStateTable.session_id, branch.id)).all()))).toEqual([])
    }), { git: true, config }),
    20000,
  )

  it.live(
    "preserves first-delivery ordering in the next model request and clears references outside a fork cutoff",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tq = yield* TurnQueue.Service
      const prompt = yield* SessionPrompt.Service
      const source = yield* sessions.create({ title: "delivery order source" })
      const firstUser = yield* user(source.id, "FIRST-INPUT")
      const lateUser = yield* user(source.id, "LATE-INPUT")
      const firstStep = yield* assistant(firstUser, "FIRST-STEP", "tool-calls")
      const finalStep = yield* assistant(lateUser, "FINAL-STEP")
      const lane = { sessionID: source.id, agentID: "main" }
      for (const [message, delivery] of [[firstUser, firstStep], [lateUser, finalStep]] as const) {
        const receipt = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: message.id } })
        yield* tq.claimNext(lane, 1)
        yield* Effect.sync(() => Database.use((db) => db.update(TurnReceiptTable).set({ delivery_message_id: delivery.id })
          .where(eq(TurnReceiptTable.id, receipt.id)).run()))
        yield* tq.ack(lane, message.id, [{ receiptId: receipt.id, outcome: "success", messageId: finalStep.id }], 1)
      }
      const branch = yield* sessions.fork({ sessionID: source.id })
      yield* Effect.addFinalizer(() => prompt.cancel(branch.id))
      yield* llm.text("FOLLOWUP-ANSWER")
      yield* prompt.prompt({ sessionID: branch.id, agent: "build", parts: [{ type: "text", text: "FOLLOWUP" }] })
      expect(yield* llm.calls).toBe(1)
      const request = JSON.stringify((yield* llm.inputs)[0].messages)
      const positions = ["FIRST-INPUT", "FIRST-STEP", "LATE-INPUT", "FINAL-STEP", "FOLLOWUP"].map((text) => request.indexOf(text))
      expect(positions.every((position) => position >= 0)).toBe(true)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))

      const truncated = yield* sessions.fork({ sessionID: source.id, messageID: finalStep.id })
      const copied = yield* sessions.messages({ sessionID: truncated.id })
      const history = yield* receipts(truncated.id)
      expect(copied).toHaveLength(3)
      expect(history).toHaveLength(2)
      expect(history.every((row) => row.consumed && row.state === "settled" && row.message_id === null)).toBe(true)
      expect(history.find((row) => row.intent.messageID === byText(copied, "FIRST-INPUT").info.id)?.delivery_message_id)
        .toBe(byText(copied, "FIRST-STEP").info.id)
      expect(history.find((row) => row.intent.messageID === byText(copied, "LATE-INPUT").info.id)?.delivery_message_id).toBeNull()
      yield* tq.reconcileOnBoot(truncated.id)
      expect(yield* tq.listAccepted({ sessionID: truncated.id, agentID: "main" })).toEqual([])
      expect(yield* llm.calls).toBe(1)
    }), { git: true, config }),
    20000,
  )

  it.live(
    "infers only frozen legacy completed prefixes, not tool-only or post-freeze users",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tq = yield* TurnQueue.Service
      const source = yield* sessions.create({ title: "legacy boundary source" })
      const prefix = yield* user(source.id, "LEGACY-PREFIX", false)
      const question = yield* user(source.id, "LEGACY-QUESTION", false)
      const answer = yield* assistant(question, "LEGACY-ANSWER")
      const pending = yield* user(source.id, "LEGACY-TOOL-ONLY", false)
      const toolStep = yield* assistant(pending, "NONTERMINAL-STEP", "tool-calls")
      yield* Effect.sync(() => Database.use((db) => db.insert(TurnLegacyBootstrapTable).values({
        session_id: source.id, message_ids: [prefix.id, question.id, answer.id, pending.id, toolStep.id],
        completed: false, time_updated: Date.now(),
      }).run()))
      const untrusted = yield* user(source.id, "POST-FREEZE-USER", false)
      yield* assistant(untrusted, "POST-FREEZE-ANSWER")
      const branch = yield* sessions.fork({ sessionID: source.id })
      const copied = yield* sessions.messages({ sessionID: branch.id })
      const history = yield* receipts(branch.id)
      expect(history).toHaveLength(4)
      for (const text of ["LEGACY-PREFIX", "LEGACY-QUESTION"]) {
        const row = history.find((row) => row.intent.messageID === byText(copied, text).info.id)!
        expect(row.consumed).toBe(true)
        expect(row.message_id).toBe(byText(copied, "LEGACY-ANSWER").info.id)
      }
      for (const text of ["LEGACY-TOOL-ONLY", "POST-FREEZE-USER"]) {
        const row = history.find((row) => row.intent.messageID === byText(copied, text).info.id)!
        expect(row.consumed).toBe(false)
        expect(row.state).toBe("cancelled")
        expect(row.outcome).toBe("never_ran")
      }
      yield* tq.reconcileOnBoot(branch.id)
      expect(yield* tq.listAccepted({ sessionID: branch.id, agentID: "main" })).toEqual([])
      expect(yield* llm.calls).toBe(0)
      expect(yield* receipts(source.id)).toEqual([])
    }), { git: true, config }),
    20000,
  )

  it.live(
    "rolls back cloned messages parts and receipts and removes the empty target when a part projector fails",
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
          expect(Database.use((db) => db.select().from(TurnReceiptTable)
            .where(eq(TurnReceiptTable.session_id, target!)).all())).toHaveLength(1)
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
