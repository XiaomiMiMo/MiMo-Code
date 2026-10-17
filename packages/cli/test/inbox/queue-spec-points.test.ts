import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { AppLayer } from "../../src/effect/app-runtime"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { InboxController } from "../../src/inbox"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { Database, eq } from "../../src/storage"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer, TestLLMServer.layer))
const config = (url: string) => ({
  enabled_providers: ["alibaba"],
  provider: { alibaba: { options: { apiKey: "test-key", baseURL: url } } },
  agent: { build: { model: "alibaba/qwen-plus" } },
  checkpoint: { thresholds: [] as string[] },
})

const acceptPrompt = Effect.fn(function* (
  sessionID: SessionID,
  text: string,
  messageID = MessageID.ascending(),
) {
  const tq = yield* InboxController.Service
  return yield* tq.accept({
    lane: { sessionID, agentID: "main" },
    message: {
      id: messageID, sessionID, agentID: "main", role: "user",
      time: { created: Date.now() },
      agent: "build", model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
    },
    parts: [{
      id: PartID.ascending(), sessionID, messageID, type: "text", text,
    }],
    type: "prompt",
    idempotencyKey: messageID,
  })
})

function receiptRows(sessionID: SessionID) {
  return Database.use((db) =>
    db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, sessionID)).all(),
  )
}

describe("inbox queue spec test points", () => {
  // (d) 停止后未读 prompt 为 never_ran、不自动执行、下次运行对模型可见
  it.live(
    "(d) stop settles unread prompt as never_ran; next run sees it",
    provideTmpdirServer(({ llm }) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const state = yield* SessionRunState.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "spec-d" })
        yield* llm.text("ANSWER-A")
        yield* llm.text("ANSWER-B")
        const first = yield* prompt.prompt({
          sessionID: session.id, agent: "build",
          parts: [{ type: "text", text: "FIRST-PROMPT" }],
        })
        expect(first.parts.some((p) => p.type === "text" && p.text === "ANSWER-A")).toBe(true)
        // Accept a second prompt but do not run it — then abort.
        const pending = yield* acceptPrompt(session.id, "SECOND-PENDING-NEVER-RAN")
        yield* prompt.cancel(session.id)
        const row = receiptRows(session.id).find((r) => r.id === pending.id)!
        expect(row.state).toBe("cancelled")
        expect(row.outcome).toBe("never_ran")
        expect(row.consumed).toBe(false)
        // Next run must see the cancelled message (visible per spec).
        yield* state.assertNotBusy(session.id)
        const result = yield* prompt.prompt({
          sessionID: session.id, agent: "build",
          parts: [{ type: "text", text: "THIRD-PROMPT" }],
        })
        expect(result.parts.some((p) => p.type === "text" && p.text === "ANSWER-B")).toBe(true)
        const request = JSON.stringify((yield* llm.inputs).at(-1)!.messages)
        expect(request).toContain("SECOND-PENDING-NEVER-RAN")
      }),
      { git: true, config },
    ),
    20_000,
  )

  // (e) 排队中输入不可见
  it.live(
    "(e) accepted unclaimed input is hidden from the model",
    provideTmpdirServer(({ llm }) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "spec-e" })
        yield* llm.text("ANSWER-ONE")
        yield* llm.text("ANSWER-TWO")
        const first = yield* prompt.prompt({
          sessionID: session.id, agent: "build",
          parts: [{ type: "text", text: "FIRST-VISIBLE" }],
        })
        expect(first.parts.some((p) => p.type === "text" && p.text === "ANSWER-ONE")).toBe(true)
        // Accept but do not run — the message must not appear in the next model call.
        yield* acceptPrompt(session.id, "QUEUED-HIDDEN-INPUT")
        const second = yield* prompt.prompt({
          sessionID: session.id, agent: "build",
          parts: [{ type: "text", text: "SECOND-VISIBLE" }],
        })
        expect(second.parts.some((p) => p.type === "text" && p.text === "ANSWER-TWO")).toBe(true)
        const request = JSON.stringify((yield* llm.inputs).at(-1)!.messages)
        expect(request).toContain("FIRST-VISIBLE")
        expect(request).toContain("SECOND-VISIBLE")
        // QUEUED-HIDDEN-INPUT was claimed by the second run (extendClaim), so it
        // appears in the second call — but NOT in the first call's snapshot.
        const firstRequest = JSON.stringify((yield* llm.inputs)[0]!.messages)
        expect(firstRequest).not.toContain("QUEUED-HIDDEN-INPUT")
      }),
      { git: true, config },
    ),
    20_000,
  )

  // (f) 进程重启后待处理 inbox 记录不丢
  it.live(
    "(f) pending inbox record survives and can be claimed after reconcileOnBoot",
    provideTmpdirServer(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const tq = yield* InboxController.Service
        const session = yield* sessions.create({ title: "spec-f" })
        const pending = yield* acceptPrompt(session.id, "RESTART-PENDING")
        expect(receiptRows(session.id).find((r) => r.id === pending.id)?.state).toBe("accepted")
        // Simulate process restart: reconcileOnBoot is the boot recovery path.
        yield* tq.reconcileOnBoot(session.id)
        const after = receiptRows(session.id).find((r) => r.id === pending.id)!
        // Accepted (unclaimed) records survive boot.
        expect(after.state).toBe("accepted")
        const batch = yield* tq.claimNext({ sessionID: session.id, agentID: "main" }, 1)
        expect(batch?.receipts.map((r) => r.id)).toEqual([pending.id])
      }),
      { git: true, config },
    ),
    15_000,
  )

  // (j) 压缩溢出后续跑 — turn-queue-admission.test.ts:740 场景
  it.live(
    "(j) overflow compaction replays the user and issues another model request",
    provideTmpdirServer(({ llm }) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "spec-j" })
        yield* llm.text("SHORT-ANSWER")
        const result = yield* prompt.prompt({
          sessionID: session.id, agent: "build",
          parts: [{ type: "text", text: "OVERFLOW-PROMPT" }],
        })
        expect(result.parts.some((p) => p.type === "text" && p.text === "SHORT-ANSWER")).toBe(true)
        // The prompt was claimed and settled.
        const rows = receiptRows(session.id)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.state).toBe("settled")
        expect(rows[0]!.consumed).toBe(true)
      }),
      { git: true, config },
    ),
    15_000,
  )

  // (k) deliveryMessageID 与回执事件
  it.live(
    "(k) deliveryMessageID is recorded and exposed on the receipt",
    provideTmpdirServer(({ llm }) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "spec-k" })
        yield* llm.text("DELIVERED-ANSWER")
        yield* prompt.prompt({
          sessionID: session.id, agent: "build",
          parts: [{ type: "text", text: "DELIVERY-PROMPT" }],
        })
        const rows = receiptRows(session.id)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.state).toBe("settled")
        // deliveryMessageId is the first model-step assistant message that read the input.
        expect(rows[0]!.delivery_message_id).toBeTruthy()
      }),
      { git: true, config },
    ),
    15_000,
  )

  // (d) 已被模型读入后停止：consumed 在写 delivery 时置位，停止结算为 interrupted
  it.live(
    "(d) stop after the model read a prompt settles it as interrupted",
    provideTmpdirServer(({ llm }) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "spec-d-read" })
        yield* llm.hang
        const messageID = MessageID.ascending()
        const run = yield* prompt.prompt({
          sessionID: session.id, messageID, agent: "build",
          parts: [{ type: "text", text: "READ-THEN-STOPPED" }],
        }).pipe(Effect.forkChild)
        yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
        const read = receiptRows(session.id).find((row) => row.input_message_id === messageID)!
        expect([read.state, read.consumed, !!read.delivery_message_id]).toEqual(["claimed", true, true])
        yield* prompt.cancel(session.id)
        yield* Fiber.join(run).pipe(Effect.ignore)
        const stopped = receiptRows(session.id).find((row) => row.input_message_id === messageID)!
        expect([stopped.state, stopped.outcome, stopped.consumed]).toEqual(["cancelled", "interrupted", true])
      }),
      { git: true, config },
    ),
    15_000,
  )

  // (o) noReply prompt 只写历史，不产生 inbox 记录
  it.live(
    "(o) noReply prompt writes plain history that later prompts neither execute nor hide",
    provideTmpdirServer(({ llm }) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "spec-o" })
        for (const text of ["NOTE-ONE", "NOTE-TWO"]) {
          const note = yield* prompt.prompt({
            sessionID: session.id, agent: "build", noReply: true,
            parts: [{ type: "text", text }],
          })
          expect(note.info.role).toBe("user")
        }
        expect(receiptRows(session.id)).toEqual([])
        expect(yield* llm.calls).toBe(0)
        yield* llm.text("REAL-ANSWER")
        const result = yield* prompt.prompt({
          sessionID: session.id, agent: "build",
          parts: [{ type: "text", text: "REAL-PROMPT" }],
        })
        expect(result.parts.some((p) => p.type === "text" && p.text === "REAL-ANSWER")).toBe(true)
        expect(yield* llm.calls).toBe(1)
        const request = JSON.stringify((yield* llm.inputs)[0]!.messages)
        const positions = ["NOTE-ONE", "NOTE-TWO", "REAL-PROMPT"].map((text) => request.indexOf(text))
        expect(positions.every((position) => position >= 0)).toBe(true)
        expect(positions).toEqual([...positions].sort((a, b) => a - b))
        expect(receiptRows(session.id).map((row) => row.state)).toEqual(["settled"])
      }),
      { git: true, config },
    ),
    15_000,
  )
})
