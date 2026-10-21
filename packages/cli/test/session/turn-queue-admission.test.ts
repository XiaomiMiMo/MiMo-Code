import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "node:path"
import { Global } from "../../src/global"
import { AppLayer } from "../../src/effect/app-runtime"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { injectScheduledPrompt, SessionPrompt } from "../../src/session/prompt"
import { inboxServiceRef } from "../../src/inbox/inbox-ref"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Database, and, eq } from "../../src/storage"
import { InboxController, inboxControllerRef, schedulerRef } from "../../src/inbox"
import { InboxLaneStateTable, InboxTable } from "../../src/inbox/inbox.sql"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer, TestLLMServer.layer))
const config = (url: string) => ({
  enabled_providers: ["alibaba"],
  provider: { alibaba: { options: { apiKey: "test-key", baseURL: url } } },
  agent: { build: { model: "alibaba/qwen-plus" } },
})

const setup = Effect.fn(function* (title: string) {
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const tq = yield* InboxController.Service
  const session = yield* sessions.create({ title })
  yield* Effect.addFinalizer(() => prompt.cancel(session.id))
  return { sessions, prompt, tq, session }
})

const responseGate = Effect.fn(function* () {
  const gate = Promise.withResolvers<void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
  return gate
})

const pauseFirstExtension = Effect.fn(function* (sessionID: SessionID) {
  const tq = yield* InboxController.Service
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let first = true
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = inboxControllerRef.current
      inboxControllerRef.current = {
        ...tq,
        extendClaim: (...args) =>
          Effect.gen(function* () {
            if (args[0].sessionID === sessionID && first) {
              first = false
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            return yield* tq.extendClaim(...args)
          }),
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        inboxControllerRef.current = previous
      }),
  )
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
  return { entered, release }
})

// One Inbox.accept, as a client prompt does: the message (with its own
// client-allocated id and format) and its inbox record are written together.
const acceptUser = Effect.fn(function* (
  sessionID: SessionID,
  text: string,
  format?: MessageV2.User["format"],
  messageID = MessageID.ascending(),
) {
  const sessions = yield* Session.Service
  const tq = yield* InboxController.Service
  const original = (yield* sessions.messages({ sessionID })).find((message) => message.info.role === "user")
  if (!original || original.info.role !== "user") throw new Error("initial user missing")
  return yield* tq.accept({
    lane: { sessionID, agentID: "main" },
    message: { ...original.info, id: messageID, time: { created: Date.now() }, format },
    parts: [{ id: PartID.ascending(), sessionID, messageID, type: "text", text }],
    type: "prompt",
    idempotencyKey: messageID,
  })
})

function receipts(sessionID: SessionID) {
  return Database.use((db) =>
    db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, sessionID)).all(),
  )
}

function frontier(sessionID: SessionID) {
  return Database.use((db) =>
    db
      .select()
      .from(InboxLaneStateTable)
      .where(and(eq(InboxLaneStateTable.session_id, sessionID), eq(InboxLaneStateTable.agent_id, "main")))
      .get(),
  )?.consumed_frontier
}

const receiptFor = Effect.fn(function* (sessionID: SessionID, messageID: MessageID) {
  const tq = yield* InboxController.Service
  const found = receipts(sessionID).filter((row) => row.input_message_id === messageID)
  expect(found).toHaveLength(1)
  return yield* tq.getReceipt(found[0].id)
})

const successful = Effect.fn(function* (receiptId: string) {
  const tq = yield* InboxController.Service
  const receipt = yield* tq.getReceipt(receiptId)
  expect(receipt.state).toBe("settled")
  expect(receipt.outcome).toBe("success")
  expect(receipt.consumed).toBe(true)
})

const runAccepted = Effect.fn(function* (sessionID: SessionID, receiptId: string) {
  const scheduler = schedulerRef.current
  if (!scheduler) throw new Error("Inbox scheduler missing")
  yield* scheduler.kick({ sessionID, agentID: "main" })
  const controller = yield* InboxController.Service
  while (["accepted", "claimed"].includes((yield* controller.getReceipt(receiptId)).state))
    yield* Effect.sleep("10 millis")
  const sessions = yield* Session.Service
  const result = (yield* sessions.messages({ sessionID, agentID: "main" })).findLast((message) => message.info.role === "assistant")
  if (!result) throw new Error("Assistant result missing")
  return result
})

function answer(result: MessageV2.WithParts, text: string, parentID: MessageID) {
  expect(result.info.role).toBe("assistant")
  if (result.info.role !== "assistant") throw new Error("assistant result missing")
  expect(result.info.parentID).toBe(parentID)
  expect(result.info.error).toBeUndefined()
  expect(result.parts.some((part) => part.type === "text" && part.text === text)).toBe(true)
}

function structuredTool(input: Record<string, unknown>) {
  return (input.tools as { function: { name: string; parameters: unknown } }[]).find(
    (tool) => tool.function.name === "StructuredOutput",
  )
}

describe("InboxController admission and claim acceptance without child execution", () => {
  it.live(
    "seedless main inbox stops scheduling and a later valid prompt consumes both receipts",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const { session, prompt, tq } = yield* setup("Seedless main inbox")
      const inbox = inboxServiceRef.current
      const scheduler = schedulerRef.current
      if (!inbox || !scheduler) throw new Error("Inbox scheduler missing")
      const input = yield* inbox.accept({ receiverSessionID: session.id, receiverActorID: "main", content: "SEEDLESS-INBOX" })
      let guardChecks = 0
      yield* scheduler.kick({ sessionID: session.id, agentID: "main" }, Effect.sync(() => { guardChecks++ }))
        .pipe(Effect.timeout("5 seconds"))
      yield* Effect.sleep("100 millis")
      expect(guardChecks).toBe(1)
      expect((yield* tq.getReceipt(input.inboxID)).state).toBe("accepted")
      expect(yield* llm.calls).toBe(0)
      yield* llm.text("SEEDED-RESPONSE")
      const nextID = MessageID.ascending()
      answer(yield* prompt.prompt({ sessionID: session.id, messageID: nextID, agent: "build",
        parts: [{ type: "text", text: "VALID-SEED-INPUT" }] }).pipe(Effect.timeout("10 seconds")), "SEEDED-RESPONSE", nextID)
      yield* successful(input.inboxID)
      yield* successful((yield* receiptFor(session.id, nextID)).id)
      expect(yield* llm.calls).toBe(1)
      expect(JSON.stringify((yield* llm.inputs)[0].messages)).toContain("SEEDLESS-INBOX")
      expect(JSON.stringify((yield* llm.inputs)[0].messages)).toContain("VALID-SEED-INPUT")
    }), { git: true, config }),
    30_000,
  )

  it.live(
    "internal structured retry persists task identity for a real write",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const { session, sessions, prompt } = yield* setup("Internal continuation task identity")
      const target = path.join(Global.Path.data, "memory", "sessions", session.id, "tasks", "T3", "progress.md")
      yield* llm.text("Missing structured result")
      yield* llm.tool("write", { file_path: target, content: "CONTINUATION-TASK" })
      yield* llm.tool("StructuredOutput", { answer: "DONE" })
      const result = yield* prompt.prompt({ sessionID: session.id, task_id: "T3", agent: "build",
        format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, retryCount: 1 },
        parts: [{ type: "text", text: "Complete task three with structured output" }] })
      expect(result.info.role === "assistant" && result.info.structured).toEqual({ answer: "DONE" })
      const users = (yield* sessions.messages({ sessionID: session.id })).filter(m => m.info.role === "user")
      expect(users).toHaveLength(2)
      expect(users.every(m => m.info.role === "user" && m.info.task_id === "T3")).toBe(true)
      expect(users[1].parts.every(p => p.type === "text" && p.synthetic)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("CONTINUATION-TASK")
      expect(yield* llm.calls).toBe(3)
    }), { git: true, config: url => ({ ...config(url), permission: { "*": "allow" } }) }),
    30_000,
  )

  for (const kindOfTask of ["cron", "loop"] as const) it.live(
    `independent synthetic ${kindOfTask} has no historical task write authority`,
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const { session, sessions, prompt } = yield* setup(`Synthetic ${kindOfTask} task isolation`)
      const target = path.join(Global.Path.data, "memory", "sessions", session.id, "tasks", "T3", "progress.md")
      yield* llm.tool("write", { file_path: target, content: "TASK-OWNER" })
      yield* llm.text("TASK-OWNER-DONE")
      yield* prompt.prompt({ sessionID: session.id, task_id: "T3", agent: "build",
        parts: [{ type: "text", text: "Write task three progress" }] })
      expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("TASK-OWNER")
      yield* llm.tool("write", { file_path: target, content: "SCHEDULED-OVERWRITE" })
      yield* llm.text("SCHEDULED-DONE")
      yield* injectScheduledPrompt({ sessionID: session.id, value: "Independent scheduled request", origin: {
        kind: "cron", taskId: `scheduled-${kindOfTask}`, kindOfTask,
      } })
      const messages = yield* sessions.messages({ sessionID: session.id })
      const scheduled = messages.findLast(m => m.info.role === "user")
      expect(scheduled?.info.role === "user" && scheduled.info.task_id).toBeUndefined()
      const tools = messages.filter(m => m.info.role === "assistant" && m.info.parentID === scheduled?.info.id)
        .flatMap(m => m.parts).filter(p => p.type === "tool")
      expect(tools).toHaveLength(1)
      expect(tools[0]).toMatchObject({ state: { status: "error", error: expect.stringContaining("reserved for the checkpoint-writer") } })
      expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("TASK-OWNER")
      expect(yield* llm.calls).toBe(4)
    }), { git: true, config: url => ({ ...config(url), permission: { "*": "allow" } }) }),
    30_000,
  )
  it.live(
    "cancel after acceptance during title persistence settles the unclaimed prompt and permits new input",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const tq = yield* InboxController.Service
      const session = yield* sessions.create()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const mutableSessions = sessions as { -readonly [Key in keyof typeof sessions]: typeof sessions[Key] }
      const original = sessions.setTitleIfDefault
      let pause = true
      mutableSessions.setTitleIfDefault = (...args: Parameters<typeof original>) => Effect.gen(function* () {
        if (pause && args[0].sessionID === session.id) {
          pause = false
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        return yield* original(...args)
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => { mutableSessions.setTitleIfDefault = original }))
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* Effect.addFinalizer(() => prompt.cancel(session.id))
      const messageID = MessageID.ascending()
      const running = yield* prompt.prompt({ sessionID: session.id, messageID, agent: "build",
        parts: [{ type: "text", text: "12345" }] }).pipe(Effect.forkChild)
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
      const accepted = yield* receiptFor(session.id, messageID)
      expect(accepted.state).toBe("accepted")
      yield* prompt.cancel(session.id)
      expect((yield* tq.getReceipt(accepted.id)).state).toBe("cancelled")
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(running).pipe(Effect.timeout("5 seconds"))
      expect(result.info.id).toBe(messageID)
      expect(result.info.role).toBe("user")
      expect(yield* llm.calls).toBe(0)
      yield* llm.text("AFTER-CANCEL")
      const nextID = MessageID.ascending()
      answer(yield* prompt.prompt({ sessionID: session.id, messageID: nextID, agent: "build",
        parts: [{ type: "text", text: "New epoch request" }] }), "AFTER-CANCEL", nextID)
      yield* successful((yield* receiptFor(session.id, nextID)).id)
      expect(yield* llm.calls).toBe(1)
    }), { git: true, config }),
    30_000,
  )

  for (const firstFails of [false, true]) it.live(
    `receipt result is independent of the next scheduled run when firstFails=${firstFails}`,
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const { session, prompt, tq } = yield* setup("Independent lane results")
      const firstGate = yield* responseGate()
      const secondGate = yield* responseGate()
      const thirdGate = yield* responseGate()
      const firstID = MessageID.ascending()
      const secondID = MessageID.ascending()
      const settling = yield* Deferred.make<void>()
      const releaseSettlement = yield* Deferred.make<void>()
      let firstSettlement = true
      const secondSettling = yield* Deferred.make<void>()
      const releaseSecondSettlement = yield* Deferred.make<void>()
      let secondSettlement = true
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseSecondSettlement, undefined))
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseSettlement, undefined))
      yield* Effect.acquireRelease(Effect.sync(() => {
        const previous = inboxControllerRef.current
        inboxControllerRef.current = { ...tq,
          ack: (...args) => Effect.gen(function* () {
            const result = yield* tq.ack(...args)
            if (args[0].sessionID === session.id && firstSettlement) {
              firstSettlement = false
              yield* Deferred.succeed(settling, undefined)
              yield* Deferred.await(releaseSettlement)
            } else if (args[0].sessionID === session.id && secondSettlement && args[2].some(item => item.receiptId === receipts(session.id).find(row => row.input_message_id === secondID)?.id)) {
              secondSettlement = false
              yield* Deferred.succeed(secondSettling, undefined)
              yield* Deferred.await(releaseSecondSettlement)
            }
            return result
          }),
        }
        return previous
      }), previous => Effect.sync(() => { inboxControllerRef.current = previous }))
      if (firstFails) yield* llm.error(400, { error: { message: "first-failed", type: "invalid_request_error" } })
      else yield* llm.hold("FIRST-OK", firstGate.promise)
      if (firstFails) yield* llm.hold("SECOND-OK", secondGate.promise)
      else yield* llm.error(400, { error: { message: "second-failed", type: "invalid_request_error" } })
      yield* llm.hold("THIRD-OK", thirdGate.promise)
      const a = yield* prompt.prompt({ sessionID: session.id, messageID: firstID, agent: "build",
        parts: [{ type: "text", text: "First independent request" }] }).pipe(Effect.forkChild)
      firstGate.resolve()
      yield* Deferred.await(settling).pipe(Effect.timeout("5 seconds"))
      const b = yield* prompt.prompt({ sessionID: session.id, messageID: secondID, agent: "build",
        parts: [{ type: "text", text: "Second independent request" }] }).pipe(Effect.forkChild)
      while (receipts(session.id).length < 2) yield* Effect.sleep("1 millis")
      yield* Deferred.succeed(releaseSettlement, undefined)
      yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
      const aExit = yield* Fiber.await(a).pipe(Effect.timeout("5 seconds"))
      if (firstFails) {
        expect(Exit.isSuccess(aExit)).toBe(true)
        if (Exit.isSuccess(aExit)) {
          expect(aExit.value.info.role).toBe("assistant")
          expect(aExit.value.info.role === "assistant" && JSON.stringify(aExit.value.info.error)).toContain("first-failed")
        }
      } else {
        expect(Exit.isSuccess(aExit)).toBe(true)
        if (Exit.isSuccess(aExit)) answer(aExit.value, "FIRST-OK", firstID)
      }
      secondGate.resolve()
      yield* Deferred.await(secondSettling).pipe(Effect.timeout("5 seconds"))
      const thirdID = MessageID.ascending()
      const c = yield* prompt.prompt({ sessionID: session.id, messageID: thirdID, agent: "build",
        parts: [{ type: "text", text: "Third independent request" }] }).pipe(Effect.forkChild)
      while (receipts(session.id).length < 3) yield* Effect.sleep("1 millis")
      yield* Deferred.succeed(releaseSecondSettlement, undefined)
      yield* llm.wait(3).pipe(Effect.timeout("5 seconds"))
      const secondResult = yield* Fiber.join(b).pipe(Effect.timeout("5 seconds"))
      if (firstFails) answer(secondResult, "SECOND-OK", secondID)
      else {
        expect(secondResult.info.role).toBe("assistant")
        expect(secondResult.info.role === "assistant" && secondResult.info.parentID).toBe(secondID)
        expect(secondResult.info.role === "assistant" && JSON.stringify(secondResult.info.error)).toContain("second-failed")
      }
      expect(c.pollUnsafe()).toBeUndefined()
      thirdGate.resolve()
      answer(yield* Fiber.join(c).pipe(Effect.timeout("5 seconds")), "THIRD-OK", thirdID)
      const firstReceipt = yield* receiptFor(session.id, firstID)
      const secondReceipt = yield* receiptFor(session.id, secondID)
      expect(firstReceipt.outcome).toBe(firstFails ? "assistant_error" : "success")
      expect(secondReceipt.outcome).toBe(firstFails ? "success" : "assistant_error")
      yield* successful((yield* receiptFor(session.id, thirdID)).id)
      expect(yield* llm.calls).toBe(3)
    }), { git: true, config }),
    30_000,
  )

  // [TP-R23-05] Turn-queue admission is the main generation boundary: one admitted run
  // allocates one generation; inputs it claims mid-turn, model steps and empty kicks do not.
  it.live(
    "main execution generation advances once per admitted run, not per claimed input or model step",
    provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
      const { session, prompt } = yield* setup("Main execution generation")
      const registry = yield* ActorRegistry.Service
      const expansion = yield* pauseFirstExtension(session.id)
      const firstGate = yield* responseGate()
      yield* llm.push(reply().wait(firstGate.promise).tool("write", { file_path: path.join(dir, "generation.txt"), content: "step" }))
      yield* llm.text("FIRST-RUN-DONE")
      const firstID = MessageID.ascending()
      const lateID = MessageID.ascending()
      const running = yield* prompt.prompt({ sessionID: session.id, messageID: firstID, agent: "build",
        parts: [{ type: "text", text: "First admitted request" }] }).pipe(Effect.forkChild)
      yield* Deferred.await(expansion.entered).pipe(Effect.timeout("5 seconds"))
      expect(yield* registry.get(session.id, "main")).toMatchObject({ executionGeneration: "1", status: "running" })
      yield* prompt.promptAsync({ sessionID: session.id, messageID: lateID, agent: "build",
        parts: [{ type: "text", text: "Input claimed by the running execution" }] })
      yield* Deferred.succeed(expansion.release, undefined)
      yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
      expect((yield* receiptFor(session.id, lateID)).state).toBe("claimed")
      firstGate.resolve()
      answer(yield* Fiber.join(running).pipe(Effect.timeout("10 seconds")), "FIRST-RUN-DONE", lateID)
      expect(yield* llm.calls).toBe(2)
      expect(yield* registry.get(session.id, "main")).toMatchObject({ executionGeneration: "1", status: "idle", lastOutcome: "success" })

      const scheduler = schedulerRef.current
      if (!scheduler) throw new Error("Inbox scheduler missing")
      yield* scheduler.kick({ sessionID: session.id, agentID: "main" })
      expect((yield* registry.get(session.id, "main"))?.executionGeneration).toBe("1")

      yield* llm.text("SECOND-RUN-DONE")
      const secondID = MessageID.ascending()
      answer(yield* prompt.prompt({ sessionID: session.id, messageID: secondID, agent: "build",
        parts: [{ type: "text", text: "Second admitted request" }] }), "SECOND-RUN-DONE", secondID)
      expect(yield* registry.get(session.id, "main")).toMatchObject({ executionGeneration: "2", status: "idle", lastOutcome: "success" })
    }), { git: true, config: url => ({ ...config(url), permission: { "*": "allow" } }) }),
    30_000,
  )

  it.live(
    "extended inputs select their own task identity for real writes and restored execution",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const { session, sessions, prompt } = yield* setup("Task identity per admitted input")
      const expansion = yield* pauseFirstExtension(session.id)
      const firstGate = yield* responseGate()
      const thirdPath = path.join(Global.Path.data, "memory", "sessions", session.id, "tasks", "T3", "progress.md")
      const fourthPath = path.join(Global.Path.data, "memory", "sessions", session.id, "tasks", "T4", "progress.md")
      yield* llm.push(reply().wait(firstGate.promise)
        .tool("write", { file_path: fourthPath, content: "T4 initial" }))
      yield* llm.tool("write", { file_path: thirdPath, content: "T4 cross-task" })
      yield* llm.text("T4-WRITTEN")
      const firstID = MessageID.ascending()
      const fourthID = MessageID.ascending()
      const running = yield* prompt.prompt({ sessionID: session.id, messageID: firstID, agent: "build", task_id: "T3",
        parts: [{ type: "text", text: "Task three request" }] }).pipe(Effect.forkChild)
      yield* Deferred.await(expansion.entered).pipe(Effect.timeout("5 seconds"))
      yield* prompt.promptAsync({ sessionID: session.id, messageID: fourthID, agent: "build", task_id: "T4",
        parts: [{ type: "text", text: "Task four request" }] })
      yield* Deferred.succeed(expansion.release, undefined)
      yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
      expect((yield* receiptFor(session.id, fourthID)).state).toBe("claimed")
      firstGate.resolve()
      answer(yield* Fiber.join(running).pipe(Effect.timeout("10 seconds")), "T4-WRITTEN", fourthID)
      const parts = (yield* sessions.messages({ sessionID: session.id })).flatMap(m => m.parts)
      expect(parts.find(p => p.type === "tool" && p.state.input.file_path === fourthPath))
        .toMatchObject({ state: { status: "completed" } })
      expect(parts.find(p => p.type === "tool" && p.state.input.file_path === thirdPath))
        .toMatchObject({ state: { status: "error", error: expect.stringContaining("reserved for the checkpoint-writer") } })
      expect(yield* Effect.promise(() => Bun.file(fourthPath).text())).toBe("T4 initial")
      expect(yield* Effect.promise(() => Bun.file(thirdPath).exists())).toBe(false)
      const stored = (yield* sessions.messages({ sessionID: session.id })).find(m => m.info.id === fourthID)
      expect(stored?.info.role === "user" && stored.info.task_id).toBe("T4")

      const restoredID = MessageID.ascending()
      yield* prompt.prompt({ sessionID: session.id, messageID: restoredID, agent: "build", task_id: "T3", noReply: true,
        parts: [{ type: "text", text: "Persist task three for restored execution" }] })
      yield* llm.tool("write", { file_path: thirdPath, content: "T3 restored" })
      yield* llm.text("T3-RESTORED")
      answer(yield* prompt.loop({ sessionID: session.id }), "T3-RESTORED", restoredID)
      expect(yield* Effect.promise(() => Bun.file(thirdPath).text())).toBe("T3 restored")
      expect(yield* Effect.promise(() => Bun.file(fourthPath).text())).toBe("T4 initial")

      const clearID = MessageID.ascending()
      yield* llm.tool("write", { file_path: thirdPath, content: "Unbound overwrite" })
      yield* llm.text("TASK-CLEARED")
      answer(yield* prompt.prompt({ sessionID: session.id, messageID: clearID, agent: "build",
        parts: [{ type: "text", text: "A new input without a task" }] }), "TASK-CLEARED", clearID)
      const lastTools = (yield* sessions.messages({ sessionID: session.id })).filter(m =>
        m.info.role === "assistant" && m.info.parentID === clearID).flatMap(m => m.parts).filter(p => p.type === "tool")
      expect(lastTools).toHaveLength(1)
      expect(lastTools[0]).toMatchObject({ state: { status: "error", error: expect.stringContaining("reserved for the checkpoint-writer") } })
      expect(yield* Effect.promise(() => Bun.file(thirdPath).text())).toBe("T3 restored")
    }), { git: true, config: url => ({ ...config(url), permission: { "*": "allow" } }) }),
    30_000,
  )

  it.live(
    "failed delegated subtask anchors its delivery once and is not replayed by the next prompt",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { session, sessions, prompt } = yield* setup("Delegation failure delivery")
          const messageID = MessageID.ascending()
          yield* llm.text("Delegation failed once")
          const result = yield* prompt.prompt({
            sessionID: session.id,
            messageID,
            agent: "build",
            parts: [{ type: "subtask", prompt: "Delegate request", description: "", agent: "explore" }],
          }).pipe(Effect.timeout("10 seconds"))
          answer(result, "Delegation failed once", messageID)
          const messages = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
          const delegated = messages.filter((message) =>
            message.parts.some((part) => part.type === "tool" && part.tool === "actor"),
          )
          expect(delegated).toHaveLength(1)
          expect(delegated[0].parts.find((part) => part.type === "tool" && part.tool === "actor"))
            .toMatchObject({ state: { status: "error" } })
          const receipt = yield* receiptFor(session.id, messageID)
          yield* successful(receipt.id)
          expect(receipts(session.id).find((row) => row.id === receipt.id)?.delivery_message_id)
            .toBe(delegated[0].info.id)
          yield* llm.text("Follow-up complete")
          const later = yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "Continue without repeating delegation" }],
          })
          expect(later.parts.some((part) => part.type === "text" && part.text === "Follow-up complete")).toBe(true)
          expect((yield* sessions.messages({ sessionID: session.id, agentID: "main" }))
            .flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === "actor"))
            .toHaveLength(1)
          expect(yield* llm.calls).toBe(2)
        }),
      { git: true, config },
    ),
    30_000,
  )

  for (const change of ["replace", "clear"] as const) {
      it.live(
        `lower-ID input accepted after a higher one settled runs below the frontier, format ${change}`,
        provideTmpdirServer(
          ({ llm }) =>
            Effect.gen(function* () {
              const { session, sessions, prompt, tq } = yield* setup(`A lower id after ack ${change}`)
              const initialID = MessageID.ascending()
              yield* llm.text("U0-ANSWER")
              yield* prompt.prompt({
                sessionID: session.id,
                messageID: initialID,
                agent: "build",
                parts: [{ type: "text", text: "U0 establishes the previously consumed input" }],
              })
              yield* successful((yield* receiptFor(session.id, initialID)).id)
              expect(frontier(session.id)).toBe(initialID)

              const lowerID = MessageID.ascending()
              const upperID = MessageID.ascending()
              const lowerText = `LOWER-ID-${change}`
              const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
              const replacement = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }
              const lowerFormat: MessageV2.User["format"] =
                change === "replace" ? { type: "json_schema", schema: replacement, retryCount: 0 } : undefined
              expect(initialID < lowerID && lowerID < upperID).toBe(true)
              yield* llm.tool("StructuredOutput", { answer: "U2-ANSWER" })
              const upper = yield* prompt.prompt({
                sessionID: session.id,
                messageID: upperID,
                agent: "build",
                parts: [{ type: "text", text: "U2 owns schema A" }],
                format: { type: "json_schema", schema, retryCount: 0 },
              })
              expect(upper.info.role).toBe("assistant")
              if (upper.info.role !== "assistant") throw new Error("U2 assistant missing")
              expect(upper.info.parentID).toBe(upperID)
              expect(upper.info.structured).toEqual({ answer: "U2-ANSWER" })
              const upperReceipt = yield* receiptFor(session.id, upperID)
              yield* successful(upperReceipt.id)
              expect(frontier(session.id)).toBe(upperID)
              expect(yield* llm.calls).toBe(2)
              expect(JSON.stringify((yield* llm.inputs)[1]!.messages).includes(lowerText)).toBe(false)
              expect(structuredTool((yield* llm.inputs)[1]!)?.function.parameters).toEqual(schema)
              expect(receipts(session.id).filter((row) => row.input_message_id === lowerID)).toHaveLength(0)

              const epoch = yield* tq.getEpoch(session.id)
              const receipt = yield* acceptUser(session.id, lowerText, lowerFormat, lowerID)
              expect(receipt.state).toBe("accepted")
              expect(receipt.epoch).toBe(epoch)
              if (change === "replace") yield* llm.tool("StructuredOutput", { summary: "U1-NEW-ANSWER" })
              else yield* llm.text("U1-NEW-PLAIN-ANSWER")
              const result = yield* runAccepted(session.id, receipt.id)
                .pipe(Effect.timeout("10 seconds"))
              expect(yield* llm.calls).toBe(3)
              const input = (yield* llm.inputs)[2]!
              expect(JSON.stringify(input.messages)).toContain(lowerText)
              if (change === "replace") expect(structuredTool(input)?.function.parameters).toEqual(replacement)
              else expect(structuredTool(input)).toBeUndefined()
              expect(result.info.role).toBe("assistant")
              if (result.info.role !== "assistant") throw new Error("U1 assistant missing")
              expect(result.info.id).not.toBe(upper.info.id)
              expect(result.info.parentID).toBe(lowerID)
              expect(result.info.error).toBeUndefined()
              expect(result.info.structured).toEqual(change === "replace" ? { summary: "U1-NEW-ANSWER" } : undefined)
              if (change === "clear") answer(result, "U1-NEW-PLAIN-ANSWER", lowerID)
              yield* successful(receipt.id)
              expect((yield* receiptFor(session.id, lowerID)).id).toBe(receipt.id)
              expect(frontier(session.id)).toBe(upperID)
              expect(yield* tq.getReceipt(upperReceipt.id)).toEqual(upperReceipt)
              const assistants = (yield* sessions.messages({ sessionID: session.id })).filter(
                (message) => message.info.role === "assistant" && message.info.parentID === lowerID,
              )
              expect(assistants).toHaveLength(1)
            }),
          { git: true, config },
        ),
        30_000,
      )
  }

  it.live(
    "separate batches claimed in one run retain their own assistant positions in the next prompt",
    provideTmpdirServer(
      ({ llm, dir }) =>
        Effect.gen(function* () {
          const { session, prompt } = yield* setup("A multiple deliveries in one run")
          const first = yield* responseGate()
          const second = yield* responseGate()
          yield* llm.push(reply().wait(first.promise).tool("read", { file_path: dir }))
          yield* llm.hold("MULTIBATCH-A2-FINAL", second.promise)
          const firstID = MessageID.ascending()
          const main = yield* prompt
            .prompt({
              sessionID: session.id,
              messageID: firstID,
              agent: "build",
              parts: [{ type: "text", text: "MULTIBATCH-U1" }],
            })
            .pipe(Effect.forkChild)
          yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
          const firstReceipt = yield* receiptFor(session.id, firstID)
          expect(firstReceipt.state).toBe("claimed")
          const secondID = MessageID.ascending()
          yield* prompt.promptAsync({
            sessionID: session.id,
            messageID: secondID,
            agent: "build",
            parts: [{ type: "text", text: "MULTIBATCH-U2" }],
          })
          expect((yield* receiptFor(session.id, secondID)).state).toBe("accepted")
          expect(yield* llm.calls).toBe(1)
          first.resolve()
          yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
          const secondReceipt = yield* receiptFor(session.id, secondID)
          expect(secondReceipt.state).toBe("claimed")
          expect(secondReceipt.runId).toBe(firstReceipt.runId)
          second.resolve()
          answer(yield* Fiber.join(main).pipe(Effect.timeout("5 seconds")), "MULTIBATCH-A2-FINAL", secondID)
          yield* successful(firstReceipt.id)
          yield* successful(secondReceipt.id)
          const thirdID = MessageID.ascending()
          yield* llm.text("MULTIBATCH-A3-FINAL")
          yield* prompt.prompt({
            sessionID: session.id,
            messageID: thirdID,
            agent: "build",
            parts: [{ type: "text", text: "MULTIBATCH-U3" }],
          })
          expect(yield* llm.calls).toBe(3)
          const messages = (yield* llm.inputs)[2]!.messages as {
            role: string
            content: unknown
            tool_calls?: { function: { name: string } }[]
          }[]
          const userIndices = ["MULTIBATCH-U1", "MULTIBATCH-U2", "MULTIBATCH-U3"].map((text) => {
            const indices = messages.flatMap((message, index) =>
              message.role === "user" && JSON.stringify(message.content).includes(text) ? [index] : [],
            )
            expect(indices).toHaveLength(1)
            return indices[0]
          })
          const firstAssistant = messages.findIndex(
            (message) =>
              message.role === "assistant" && message.tool_calls?.some((call) => call.function.name === "read"),
          )
          const toolResult = messages.findIndex((message) => message.role === "tool")
          const secondAssistant = messages.findIndex(
            (message) =>
              message.role === "assistant" && JSON.stringify(message.content).includes("MULTIBATCH-A2-FINAL"),
          )
          expect(firstAssistant).toBeGreaterThan(userIndices[0])
          expect(toolResult).toBeGreaterThan(firstAssistant)
          expect(userIndices[1]).toBeGreaterThan(toolResult)
          expect(secondAssistant).toBeGreaterThan(userIndices[1])
          expect(userIndices[2]).toBeGreaterThan(secondAssistant)
          expect(frontier(session.id)).toBe(thirdID)
          yield* successful((yield* receiptFor(session.id, thirdID)).id)
        }),
      { git: true, config },
    ),
    30_000,
  )

  it.live(
    "late lower-ID input keeps one fixed position across tool continuation and the next independent prompt",
    provideTmpdirServer(
      ({ llm, dir }) =>
        Effect.gen(function* () {
          const { session, sessions, prompt, tq } = yield* setup("A stable delivery projection")
          const initialID = MessageID.ascending()
          yield* llm.text("PROJECTION-U0-ANSWER")
          yield* prompt.prompt({
            sessionID: session.id,
            messageID: initialID,
            agent: "build",
            parts: [{ type: "text", text: "PROJECTION-U0" }],
          })
          const lowerID = MessageID.ascending()
          const upperID = MessageID.ascending()
          yield* llm.text("PROJECTION-U2-COMPLETED")
          yield* prompt.prompt({
            sessionID: session.id,
            messageID: upperID,
            agent: "build",
            parts: [{ type: "text", text: "PROJECTION-U2" }],
          })
          yield* successful((yield* receiptFor(session.id, upperID)).id)
          expect(frontier(session.id)).toBe(upperID)
          const receipt = yield* acceptUser(session.id, "PROJECTION-LATE-U1", undefined, lowerID)
          yield* llm.tool("read", { file_path: dir })
          yield* llm.text("PROJECTION-U1-COMPLETED")
          const result = yield* runAccepted(session.id, receipt.id)
            .pipe(Effect.timeout("10 seconds"))
          answer(result, "PROJECTION-U1-COMPLETED", lowerID)
          yield* successful(receipt.id)
          expect(frontier(session.id)).toBe(upperID)
          expect(yield* llm.calls).toBe(4)
          const toolParts = (yield* sessions.messages({ sessionID: session.id }))
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool" && part.tool === "read")
          expect(toolParts).toHaveLength(1)
          expect(toolParts[0].type === "tool" && toolParts[0].state.status).toBe("completed")

          const nextID = MessageID.ascending()
          yield* llm.text("PROJECTION-U3-COMPLETED")
          yield* prompt.prompt({
            sessionID: session.id,
            messageID: nextID,
            agent: "build",
            parts: [{ type: "text", text: "PROJECTION-NEXT-U3" }],
          })
          expect(yield* llm.calls).toBe(5)
          const inputs = yield* llm.inputs
          type ModelMessage = { role: string; content: unknown; tool_calls?: { function: { name: string } }[] }
          const snapshots = inputs.slice(2).map((input) => input.messages as ModelMessage[])
          const lowerIndices = snapshots.map((messages) => {
            const matches = messages.flatMap((message, index) =>
              message.role === "user" && JSON.stringify(message.content).includes("PROJECTION-LATE-U1") ? [index] : [],
            )
            expect(matches).toHaveLength(1)
            const upperAnswer = messages.findIndex(
              (message) =>
                message.role === "assistant" && JSON.stringify(message.content).includes("PROJECTION-U2-COMPLETED"),
            )
            expect(upperAnswer).toBeGreaterThanOrEqual(0)
            expect(matches[0]).toBeGreaterThan(upperAnswer)
            return matches[0]
          })
          expect(lowerIndices[1]).toBe(lowerIndices[0])
          expect(lowerIndices[2]).toBe(lowerIndices[0])
          for (const [index, messages] of snapshots.entries()) {
            if (index === 0) continue
            const toolCall = messages.findIndex(
              (message) =>
                message.role === "assistant" && message.tool_calls?.some((call) => call.function.name === "read"),
            )
            const toolResult = messages.findIndex((message) => message.role === "tool")
            expect(toolCall).toBeGreaterThan(lowerIndices[index])
            expect(toolResult).toBeGreaterThan(toolCall)
            if (index === 2) {
              const lowerAnswer = messages.findIndex(
                (message) =>
                  message.role === "assistant" && JSON.stringify(message.content).includes("PROJECTION-U1-COMPLETED"),
              )
              const nextUser = messages.findIndex(
                (message) => message.role === "user" && JSON.stringify(message.content).includes("PROJECTION-NEXT-U3"),
              )
              expect(lowerAnswer).toBeGreaterThan(toolResult)
              expect(nextUser).toBeGreaterThan(lowerAnswer)
            }
          }
          expect(frontier(session.id)).toBe(nextID)
          yield* successful((yield* receiptFor(session.id, nextID)).id)
          expect((yield* receiptFor(session.id, lowerID)).id).toBe(receipt.id)
        }),
      { git: true, config },
    ),
    30_000,
  )

  for (const timing of ["before run", "during compaction continue"] as const)
    it.live(
      `pending input hidden ${timing} is loaded by ID and stays before its real tool continuation`,
      provideTmpdirServer(
        ({ llm, dir }) =>
          Effect.gen(function* () {
            const { session, sessions, prompt, tq } = yield* setup(`A pending input hidden ${timing}`)
            const initialID = MessageID.ascending()
            yield* llm.text("BEFORE-BOUNDARY-ANSWER")
            yield* prompt.prompt({
              sessionID: session.id,
              messageID: initialID,
              agent: "build",
              parts: [{ type: "text", text: "BEFORE-BOUNDARY-USER" }],
            })
            const receipt = yield* acceptUser(session.id, "PENDING-BEHIND-BOUNDARY")
            const pendingID = receipt.inputMessageID
            expect(receipt.state).toBe("accepted")
            const original = MessageV2.get({ sessionID: session.id, messageID: initialID })
            if (original.info.role !== "user") throw new Error("initial user missing")
            const boundaryInfo = original.info
            const boundaryID = MessageID.ascending()
            const insertBoundary = Effect.gen(function* () {
              yield* sessions.updateMessage({ ...boundaryInfo, id: boundaryID, time: { created: Date.now() } })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: boundaryID,
                type: "checkpoint",
                checkpointDir: dir,
                checkpointNumber: 1,
                coveredUpTo: initialID,
              })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: boundaryID,
                type: "text",
                synthetic: true,
                text: "CHECKPOINT-BOUNDARY-SUMMARY",
              })
              expect(pendingID < boundaryID).toBe(true)
              const filtered = yield* MessageV2.filterCompactedEffect(session.id, { agentID: "main" })
              expect(filtered.map((message) => message.info.id)).toContain(boundaryID)
              expect(filtered.map((message) => message.info.id)).not.toContain(pendingID)
            })
            let compactions = 0
            if (timing === "before run") {
              yield* insertBoundary
            } else {
              const compaction = yield* SessionCompaction.Service
              const markerID = PartID.ascending()
              yield* sessions.updatePart({
                id: markerID,
                sessionID: session.id,
                messageID: pendingID,
                type: "compaction",
                auto: true,
              })
              const process: typeof compaction.process = (input) =>
                Effect.gen(function* () {
                  compactions++
                  expect(compactions).toBe(1)
                  expect(input.sessionID).toBe(session.id)
                  expect(input.parentID).toBe(pendingID)
                  expect((yield* tq.getReceipt(receipt.id).pipe(Effect.orDie)).state).toBe("claimed")
                  expect(yield* llm.calls).toBe(1)
                  expect(
                    (yield* MessageV2.filterCompactedEffect(session.id, { agentID: "main" })).map(
                      (message) => message.info.id,
                    ),
                  ).toContain(pendingID)
                  yield* sessions.removePart({ sessionID: session.id, messageID: pendingID, partID: markerID })
                  yield* insertBoundary
                  return "continue" as const
                })
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  const previous = compaction.process
                  Object.assign(compaction, { process })
                  return previous
                }),
                (process) =>
                  Effect.sync(() => {
                    Object.assign(compaction, { process })
                  }),
              )
            }
            expect((yield* tq.getReceipt(receipt.id)).state).toBe("accepted")
            expect(yield* llm.calls).toBe(1)
            yield* llm.tool("read", { file_path: dir })
            yield* llm.text("PENDING-BOUNDARY-ANSWER")
            const result = yield* runAccepted(session.id, receipt.id)
              .pipe(Effect.timeout("10 seconds"))
            answer(result, "PENDING-BOUNDARY-ANSWER", pendingID)
            expect(compactions).toBe(timing === "before run" ? 0 : 1)
            expect(yield* llm.calls).toBe(3)
            const snapshots = (yield* llm.inputs).slice(1)
            for (const [index, input] of snapshots.entries()) {
              const messages = input.messages as {
                role: string
                content: unknown
                tool_calls?: { function: { name: string } }[]
              }[]
              expect(JSON.stringify(messages)).toContain("CHECKPOINT-BOUNDARY-SUMMARY")
              const pending = messages.flatMap((message, position) =>
                message.role === "user" && JSON.stringify(message.content).includes("PENDING-BEHIND-BOUNDARY")
                  ? [position]
                  : [],
              )
              expect(pending).toHaveLength(1)
              if (index === 1) {
                const toolCall = messages.findIndex(
                  (message) =>
                    message.role === "assistant" && message.tool_calls?.some((call) => call.function.name === "read"),
                )
                const toolResult = messages.findIndex((message) => message.role === "tool")
                expect(toolCall).toBeGreaterThan(pending[0])
                expect(toolResult).toBeGreaterThan(toolCall)
              }
            }
            const toolParts = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool" && part.tool === "read")
            expect(toolParts).toHaveLength(1)
            expect(toolParts[0].type === "tool" && toolParts[0].state.status).toBe("completed")
            yield* successful(receipt.id)
            expect((yield* receiptFor(session.id, pendingID)).id).toBe(receipt.id)
            expect(frontier(session.id)).toBe(pendingID)
          }),
        { git: true, config },
      ),
      30_000,
    )

  it.live(
    "an input whose id predates the assistant but is accepted during its response gets a new model answer",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { session, sessions, prompt, tq } = yield* setup("A late admission")
          const expansion = yield* pauseFirstExtension(session.id)
          const first = yield* responseGate()
          const second = yield* responseGate()
          yield* llm.hold("ORIGINAL-ANSWER", first.promise)
          yield* llm.hold("LATE-ADMISSION-ANSWER", second.promise)
          const originalID = MessageID.ascending()
          const main = yield* prompt
            .prompt({
              sessionID: session.id,
              messageID: originalID,
              agent: "build",
              parts: [{ type: "text", text: "Original request" }],
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(expansion.entered).pipe(Effect.timeout("5 seconds"))
          // Client-allocated before the assistant exists, sent only later.
          const lateID = MessageID.ascending()
          yield* Deferred.succeed(expansion.release, undefined)
          yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
          expect(JSON.stringify((yield* llm.inputs)[0]!.messages)).not.toContain("LATE-ACCEPTED-USER")
          const initialAssistant = (yield* sessions.messages({ sessionID: session.id })).find(
            (message) => message.info.role === "assistant",
          )
          if (!initialAssistant || initialAssistant.info.role !== "assistant")
            throw new Error("initial assistant missing")
          expect(lateID < initialAssistant.info.id).toBe(true)
          expect(initialAssistant.info.parentID).toBe(originalID)
          const receipt = yield* acceptUser(session.id, "LATE-ACCEPTED-USER", undefined, lateID)
          first.resolve()
          yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
          expect(JSON.stringify((yield* llm.inputs)[1]!.messages)).toContain("LATE-ACCEPTED-USER")
          expect((yield* tq.getReceipt(receipt.id)).state).toBe("claimed")
          expect(main.pollUnsafe()).toBeUndefined()
          second.resolve()
          answer(yield* Fiber.join(main).pipe(Effect.timeout("5 seconds")), "LATE-ADMISSION-ANSWER", lateID)
          yield* successful(receipt.id)
          yield* successful((yield* receiptFor(session.id, originalID)).id)
          expect(frontier(session.id)).toBe(lateID)
          expect(yield* llm.calls).toBe(2)
        }),
      { git: true, config },
    ),
    30_000,
  )

  // [TP-overflow-replay-continue] Provider 400 context overflow → real
  // compaction.process writes summary + replay user. The replay is an internal
  // continuation (no inbox record) and must stay visible so the run
  // issues the next model request instead of stopping after the summary.
  it.live(
    "provider overflow compaction replays the user and issues another model request",
    provideTmpdirServer(
      ({ llm, dir }) =>
        Effect.gen(function* () {
          // Match the Desktop harness-context-overflow e2e: checkpoint disabled so
          // provider overflow degrades to compaction (summary + replay) rather
          // than rebuild-from-checkpoint.
          const previousDisable = process.env.MIMOCODE_DISABLE_CHECKPOINT
          process.env.MIMOCODE_DISABLE_CHECKPOINT = "1"
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (previousDisable === undefined) delete process.env.MIMOCODE_DISABLE_CHECKPOINT
              else process.env.MIMOCODE_DISABLE_CHECKPOINT = previousDisable
            }),
          )
          const { session, sessions, prompt } = yield* setup("A overflow replay continue")
          // Two real user turns so overflow on the second can replay it while the
          // first still supplies pre-replay content (same shape as the Desktop
          // harness-context-overflow e2e).
          yield* llm.text("FIRST_TURN_ANSWER")
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "FIRST_TURN_REQUEST" }],
          })
          yield* llm.tool("read", { file_path: dir })
          yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })
          yield* llm.text("COMPACT_SUMMARY_BODY")
          yield* llm.text("AFTER_OVERFLOW_REPLY")

          const result = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "OVERFLOW_USER_REQUEST" }],
            })
            .pipe(Effect.timeout("15 seconds"))

          // 1 first turn + 1 tool-call step + 1 overflow 400 + 1 summary + 1 post-replay reply
          expect(yield* llm.calls).toBe(5)
          const messages = yield* sessions.messages({ sessionID: session.id })
          expect(messages.some((m) => m.info.role === "assistant" && m.info.summary === true)).toBe(true)
          expect(
            messages.some((m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "OVERFLOW_USER_REQUEST")),
          ).toBe(true)
          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") throw new Error("assistant result missing")
          expect(result.info.error).toBeUndefined()
          expect(result.parts.some((part) => part.type === "text" && part.text === "AFTER_OVERFLOW_REPLY")).toBe(true)
          const inputs = yield* llm.inputs
          const last = inputs[4] as { messages: { role: string; content: unknown }[] }
          expect(JSON.stringify(last.messages)).toContain("OVERFLOW_USER_REQUEST")
          expect(JSON.stringify(last.messages)).not.toContain("Continue if you have next steps")
        }),
      {
        git: true,
        config: (url) => ({ ...config(url), checkpoint: { thresholds: [] } }),
      },
    ),
    30_000,
  )

  it.live(
    "input admitted at extendClaim is claimed before and included in the immediately following model snapshot",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { session, prompt } = yield* setup("A extend before snapshot")
          const expansion = yield* pauseFirstExtension(session.id)
          const response = yield* responseGate()
          yield* llm.hold("BOTH-INPUTS-ANSWERED", response.promise)
          const originalID = MessageID.ascending()
          const main = yield* prompt
            .prompt({
              sessionID: session.id,
              messageID: originalID,
              agent: "build",
              parts: [{ type: "text", text: "First input" }],
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(expansion.entered).pipe(Effect.timeout("5 seconds"))
          expect(yield* llm.calls).toBe(0)
          const nextID = MessageID.ascending()
          yield* prompt.promptAsync({
            sessionID: session.id,
            messageID: nextID,
            agent: "build",
            parts: [{ type: "text", text: "ADMITTED-AT-EXTENSION" }],
          })
          const pending = yield* receiptFor(session.id, nextID)
          expect(pending.state).toBe("accepted")
          expect(yield* llm.calls).toBe(0)
          yield* Deferred.succeed(expansion.release, undefined)
          yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
          const original = yield* receiptFor(session.id, originalID)
          const expanded = yield* receiptFor(session.id, nextID)
          expect(expanded.state).toBe("claimed")
          expect(expanded.runId).toBe(original.runId)
          expect(expanded.claimFrontier).toBe(nextID)
          expect(JSON.stringify((yield* llm.inputs)[0]!.messages)).toContain("ADMITTED-AT-EXTENSION")
          response.resolve()
          answer(yield* Fiber.join(main).pipe(Effect.timeout("5 seconds")), "BOTH-INPUTS-ANSWERED", nextID)
          yield* successful(original.id)
          yield* successful(expanded.id)
          expect(frontier(session.id)).toBe(nextID)
          expect(yield* llm.calls).toBe(1)
        }),
      { git: true, config },
    ),
    30_000,
  )

  for (const change of ["replace", "clear"] as const)
    it.live(
      `late-admitted user format ${change} controls the next model snapshot and result`,
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            const { session, prompt, tq } = yield* setup(`A format ${change}`)
            const first = yield* responseGate()
            const second = yield* responseGate()
            const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
            const replacement = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }
            yield* llm.push(reply().wait(first.promise).tool("StructuredOutput", { answer: "ORIGINAL-FORMAT" }))
            if (change === "replace")
              yield* llm.push(reply().wait(second.promise).tool("StructuredOutput", { summary: "REPLACED-FORMAT" }))
            else yield* llm.hold("CLEARED-PLAIN-TEXT", second.promise)
            const main = yield* prompt
              .prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Use schema A" }],
                format: { type: "json_schema", schema, retryCount: 0 },
              })
              .pipe(Effect.forkChild)
            yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
            expect(structuredTool((yield* llm.inputs)[0]!)?.function.parameters).toEqual(schema)
            const receipt = yield* acceptUser(
              session.id,
              `ADMITTED-FORMAT-${change}`,
              change === "replace" ? { type: "json_schema", schema: replacement, retryCount: 0 } : undefined,
            )
            const lateID = receipt.inputMessageID
            first.resolve()
            yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
            const input = (yield* llm.inputs)[1]!
            expect(JSON.stringify(input.messages)).toContain(`ADMITTED-FORMAT-${change}`)
            if (change === "replace") expect(structuredTool(input)?.function.parameters).toEqual(replacement)
            else expect(structuredTool(input)).toBeUndefined()
            expect((yield* tq.getReceipt(receipt.id)).state).toBe("claimed")
            second.resolve()
            const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
            expect(result.info.role).toBe("assistant")
            if (result.info.role !== "assistant") throw new Error("assistant result missing")
            expect(result.info.parentID).toBe(lateID)
            expect(result.info.error).toBeUndefined()
            expect(result.info.structured).toEqual(change === "replace" ? { summary: "REPLACED-FORMAT" } : undefined)
            if (change === "clear") answer(result, "CLEARED-PLAIN-TEXT", lateID)
            yield* successful(receipt.id)
            expect(frontier(session.id)).toBe(lateID)
            expect(yield* llm.calls).toBe(2)
          }),
        { git: true, config },
      ),
      30_000,
    )
})
