import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AppLayer } from "../../src/effect/app-runtime"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Database, and, eq } from "../../src/storage"
import { TurnQueue, turnQueueRef } from "../../src/turn-queue"
import { TurnLaneStateTable, TurnReceiptTable } from "../../src/turn-queue/turn-queue.sql"
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
  const tq = yield* TurnQueue.Service
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
  const tq = yield* TurnQueue.Service
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let first = true
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = turnQueueRef.current
      turnQueueRef.current = {
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
        turnQueueRef.current = previous
      }),
  )
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
  return { entered, release }
})

const persistUser = Effect.fn(function* (
  sessionID: SessionID,
  text: string,
  format?: MessageV2.User["format"],
  messageID = MessageID.ascending(),
) {
  const sessions = yield* Session.Service
  const original = (yield* sessions.messages({ sessionID })).find((message) => message.info.role === "user")
  if (!original || original.info.role !== "user") throw new Error("initial user missing")
  yield* sessions.updateMessage({ ...original.info, id: messageID, time: { created: Date.now() }, format })
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID, messageID, type: "text", text })
  return messageID
})

function receipts(sessionID: SessionID) {
  return Database.use((db) =>
    db.select().from(TurnReceiptTable).where(eq(TurnReceiptTable.session_id, sessionID)).all(),
  )
}

function frontier(sessionID: SessionID) {
  return Database.use((db) =>
    db
      .select()
      .from(TurnLaneStateTable)
      .where(and(eq(TurnLaneStateTable.session_id, sessionID), eq(TurnLaneStateTable.agent_id, "main")))
      .get(),
  )?.consumed_frontier
}

const receiptFor = Effect.fn(function* (sessionID: SessionID, messageID: MessageID) {
  const tq = yield* TurnQueue.Service
  const found = receipts(sessionID).filter((row) => row.intent.kind === "prompt" && row.intent.messageID === messageID)
  expect(found).toHaveLength(1)
  return yield* tq.getReceipt(found[0].id)
})

const successful = Effect.fn(function* (receiptId: string) {
  const tq = yield* TurnQueue.Service
  const receipt = yield* tq.getReceipt(receiptId)
  expect(receipt.state).toBe("settled")
  expect(receipt.outcome).toBe("success")
  expect(receipt.consumed).toBe(true)
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

describe("TurnQueue admission and claim acceptance without child execution", () => {
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

  for (const persisted of ["before U2 execution", "after U2 ack"] as const) {
    for (const change of ["replace", "clear"] as const) {
      it.live(
        `admission hole: U1 persisted ${persisted}, first admitted below frontier, format ${change}`,
        provideTmpdirServer(
          ({ llm }) =>
            Effect.gen(function* () {
              const { session, sessions, prompt, tq } = yield* setup(`A admission hole ${persisted} ${change}`)
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
              const lowerText = `UNADMITTED-LOWER-ID-${change}`
              const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
              const replacement = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }
              const lowerFormat: MessageV2.User["format"] =
                change === "replace" ? { type: "json_schema", schema: replacement, retryCount: 0 } : undefined
              expect(initialID < lowerID && lowerID < upperID).toBe(true)
              if (persisted === "before U2 execution") {
                yield* persistUser(session.id, lowerText, lowerFormat, lowerID)
              }
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
              expect(receipts(session.id).filter((row) => row.intent.messageID === lowerID)).toHaveLength(0)
              if (persisted === "after U2 ack") {
                yield* persistUser(session.id, lowerText, lowerFormat, lowerID)
              }

              const epoch = yield* tq.getEpoch(session.id)
              const receipt = yield* tq.admit({
                lane: { sessionID: session.id, agentID: "main" },
                intent: { kind: "prompt", messageID: lowerID },
              })
              expect(receipt.state).toBe("accepted")
              expect(receipt.epoch).toBe(epoch)
              if (change === "replace") yield* llm.tool("StructuredOutput", { summary: "U1-NEW-ANSWER" })
              else yield* llm.text("U1-NEW-PLAIN-ANSWER")
              const result = yield* prompt
                .loop({ sessionID: session.id, requireClaim: true, expectedEpoch: epoch })
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
          yield* prompt.prompt({
            sessionID: session.id,
            messageID: secondID,
            agent: "build",
            noReply: true,
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
          yield* persistUser(session.id, "PROJECTION-LATE-U1", undefined, lowerID)
          const receipt = yield* tq.admit({
            lane: { sessionID: session.id, agentID: "main" },
            intent: { kind: "prompt", messageID: lowerID },
          })
          yield* llm.tool("read", { file_path: dir })
          yield* llm.text("PROJECTION-U1-COMPLETED")
          const result = yield* prompt
            .loop({ sessionID: session.id, requireClaim: true, expectedEpoch: receipt.epoch })
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
            const pendingID = yield* persistUser(session.id, "PENDING-BEHIND-BOUNDARY")
            const receipt = yield* tq.admit({
              lane: { sessionID: session.id, agentID: "main" },
              intent: { kind: "prompt", messageID: pendingID },
            })
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
            const result = yield* prompt
              .loop({ sessionID: session.id, requireClaim: true, expectedEpoch: receipt.epoch })
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
    "wake-only extension preserves the current claim and advances the consumed frontier monotonically",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { session, prompt, tq } = yield* setup("A monotonic frontier")
          const firstID = MessageID.ascending()
          yield* llm.text("U0-ANSWER")
          yield* prompt.prompt({
            sessionID: session.id,
            messageID: firstID,
            agent: "build",
            parts: [{ type: "text", text: "Consumed U0" }],
          })
          expect(frontier(session.id)).toBe(firstID)
          const firstReceipt = yield* receiptFor(session.id, firstID)
          yield* successful(firstReceipt.id)
          const expansion = yield* pauseFirstExtension(session.id)
          const response = yield* responseGate()
          yield* llm.hold("U1-ANSWER", response.promise)
          const currentID = MessageID.ascending()
          const main = yield* prompt
            .prompt({
              sessionID: session.id,
              messageID: currentID,
              agent: "build",
              parts: [{ type: "text", text: "Current U1 must remain visible" }],
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(expansion.entered).pipe(Effect.timeout("5 seconds"))
          const wake = yield* tq.admit({
            lane: { sessionID: session.id, agentID: "main" },
            intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "A-wake" },
          })
          yield* Deferred.succeed(expansion.release, undefined)
          yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
          const input = (yield* llm.inputs)[1]!
          expect(JSON.stringify(input.messages)).toContain("Current U1 must remain visible")
          const current = yield* receiptFor(session.id, currentID)
          const extended = yield* tq.getReceipt(wake.id)
          expect(current.state).toBe("claimed")
          expect(extended.state).toBe("claimed")
          expect(extended.runId).toBe(current.runId)
          expect(extended.claimFrontier).toBe(currentID)
          expect(frontier(session.id)).toBe(firstID)
          response.resolve()
          answer(yield* Fiber.join(main).pipe(Effect.timeout("5 seconds")), "U1-ANSWER", currentID)
          yield* successful(current.id)
          expect((yield* tq.getReceipt(wake.id)).outcome).toBe("success")
          expect(frontier(session.id)).toBe(currentID)
          expect(yield* tq.getReceipt(firstReceipt.id)).toEqual(firstReceipt)
          expect(yield* llm.calls).toBe(2)
        }),
      { git: true, config },
    ),
    30_000,
  )

  it.live(
    "a user persisted before assistant creation but admitted during its response gets a new model answer",
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
          const lateID = yield* persistUser(session.id, "LATE-PERSISTED-USER")
          yield* Deferred.succeed(expansion.release, undefined)
          yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
          expect(JSON.stringify((yield* llm.inputs)[0]!.messages)).not.toContain("LATE-PERSISTED-USER")
          const initialAssistant = (yield* sessions.messages({ sessionID: session.id })).find(
            (message) => message.info.role === "assistant",
          )
          if (!initialAssistant || initialAssistant.info.role !== "assistant")
            throw new Error("initial assistant missing")
          expect(lateID < initialAssistant.info.id).toBe(true)
          expect(initialAssistant.info.parentID).toBe(originalID)
          const receipt = yield* tq.admit({
            lane: { sessionID: session.id, agentID: "main" },
            intent: { kind: "prompt", messageID: lateID },
          })
          first.resolve()
          yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
          expect(JSON.stringify((yield* llm.inputs)[1]!.messages)).toContain("LATE-PERSISTED-USER")
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

  it.live(
    "a persisted but unadmitted user is excluded from execution and cannot advance the consumed frontier",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { session, prompt } = yield* setup("A unadmitted input")
          const response = yield* responseGate()
          yield* llm.hold("ONLY-ADMITTED-ANSWER", response.promise)
          const originalID = MessageID.ascending()
          const main = yield* prompt
            .prompt({
              sessionID: session.id,
              messageID: originalID,
              agent: "build",
              parts: [{ type: "text", text: "Only admitted request" }],
            })
            .pipe(Effect.forkChild)
          yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
          const unadmittedID = yield* persistUser(session.id, "UNADMITTED-MUST-NOT-BE-CONSUMED")
          expect(unadmittedID > originalID).toBe(true)
          response.resolve()
          answer(yield* Fiber.join(main).pipe(Effect.timeout("5 seconds")), "ONLY-ADMITTED-ANSWER", originalID)
          expect(yield* llm.calls).toBe(1)
          expect(JSON.stringify(yield* llm.inputs)).not.toContain("UNADMITTED-MUST-NOT-BE-CONSUMED")
          expect(receipts(session.id).filter((row) => row.intent.messageID === unadmittedID)).toHaveLength(0)
          expect(frontier(session.id)).toBe(originalID)
          yield* successful((yield* receiptFor(session.id, originalID)).id)
        }),
      { git: true, config },
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
          yield* prompt.prompt({
            sessionID: session.id,
            messageID: nextID,
            agent: "build",
            noReply: true,
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
            const lateID = yield* persistUser(
              session.id,
              `ADMITTED-FORMAT-${change}`,
              change === "replace" ? { type: "json_schema", schema: replacement, retryCount: 0 } : undefined,
            )
            const receipt = yield* tq.admit({
              lane: { sessionID: session.id, agentID: "main" },
              intent: { kind: "prompt", messageID: lateID },
            })
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
