import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { planExitContinuationRef } from "../../src/session/plan-exit-continuation-ref"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Truncate } from "../../src/tool"
import { PlanExitTool } from "../../src/tool/plan"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    Question.defaultLayer,
    Provider.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

const ctx = (sessionID: SessionID, agent: string) => ({
  sessionID,
  messageID: MessageID.ascending(),
  callID: "test-call",
  agent,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const pending = Effect.fn("PlanToolTest.pending")(function* (question: Question.Interface) {
  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Effect.sleep("10 millis")
  }
})

describe("tool.plan", () => {
  it.live("plan_exit answering No resolves with continue-planning guidance", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const question = yield* Question.Service
        const info = yield* sessions.create({ title: "Test" })
        const tool = yield* (yield* PlanExitTool).init()

        const fiber = yield* tool.execute({}, ctx(info.id, "plan")).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        yield* question.reply({ requestID: item.id, answers: [["No"]] })

        const result = yield* Fiber.join(fiber)
        expect(result.metadata).toMatchObject({ switched: false, feedback: "" })
        expect(result.output).toContain("stay in plan mode")
        expect(result.output).toContain("question tool")
        expect(result.output).toContain("do NOT start implementing")
      }),
    ),
  )

  it.live("plan_exit feedback answer reminds that plan mode is still active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const question = yield* Question.Service
        const info = yield* sessions.create({ title: "Test" })
        const tool = yield* (yield* PlanExitTool).init()

        const fiber = yield* tool.execute({}, ctx(info.id, "plan")).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        yield* question.reply({ requestID: item.id, answers: [["please add tests to the plan"]] })

        const result = yield* Fiber.join(fiber)
        expect(result.metadata).toMatchObject({ switched: false, feedback: "please add tests to the plan" })
        expect(result.output).toContain("please add tests to the plan")
        expect(result.output).toContain("Plan mode is still active")
      }),
    ),
  )

  it.live("plan_exit answering Yes invokes the idle continuation with the synthetic build message", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const question = yield* Question.Service
        const info = yield* sessions.create({ title: "Test" })
        // Seed a model-bearing user message so the Yes path resolves the model
        // from history instead of provider.defaultModel (keeps the test offline).
        const seedMsgID = MessageID.ascending()
        yield* sessions.updateMessage({
          id: seedMsgID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "plan",
          model: { providerID: ProviderID.make("seed"), modelID: ModelID.make("seed") },
        } satisfies MessageV2.User)
        // Pre-create the plan_exit tool part in the error state a dead run's
        // cleanup leaves behind, so the rewrite branch is exercised. The parent
        // assistant message must exist first or the part insert hits a FK.
        const messageID = MessageID.ascending()
        yield* sessions.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: seedMsgID,
          modelID: ModelID.make("seed"),
          providerID: ProviderID.make("seed"),
          mode: "primary",
          agent: "plan",
          path: { cwd: Instance.worktree, root: Instance.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies MessageV2.Assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "tool",
          callID: "test-call",
          tool: "plan_exit",
          state: {
            status: "error",
            input: {},
            error: "Tool execution aborted",
            time: { start: Date.now(), end: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
        const tool = yield* (yield* PlanExitTool).init()

        const calls: { sessionID: SessionID; userMessageID: MessageID }[] = []
        planExitContinuationRef.current = {
          continueFromUserMessage: (input) =>
            Effect.sync(() => {
              calls.push(input)
              return true
            }),
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => (planExitContinuationRef.current = undefined)))

        const fiber = yield* tool.execute({}, { ...ctx(info.id, "plan"), messageID }).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        yield* question.reply({ requestID: item.id, answers: [["Yes"]] })

        const result = yield* Fiber.join(fiber)
        expect(result.metadata).toMatchObject({ switched: true, feedback: "" })
        expect(calls.length).toBe(1)
        expect(calls[0]!.sessionID).toBe(info.id)

        const msgs = yield* sessions.messages({ sessionID: info.id, agentID: "main" })
        const synthetic = msgs.find((m) => m.info.id === calls[0]!.userMessageID)
        expect(synthetic?.info.role).toBe("user")
        if (synthetic?.info.role === "user") expect(synthetic.info.agent).toBe("build")

        const part = MessageV2.parts(messageID).find((p) => p.type === "tool")
        expect(part?.type).toBe("tool")
        if (part?.type === "tool") {
          expect(part.state.status).toBe("completed")
          if (part.state.status === "completed") expect(part.state.metadata.switched).toBe(true)
        }
      }),
    ),
  )

  it.live("plan_exit dismissing (Esc) stays in plan mode instead of failing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const question = yield* Question.Service
        const info = yield* sessions.create({ title: "Test" })
        const tool = yield* (yield* PlanExitTool).init()

        const fiber = yield* tool.execute({}, ctx(info.id, "plan")).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        yield* question.reject(item.id)

        const result = yield* Fiber.join(fiber)
        expect(result.metadata).toMatchObject({ switched: false, feedback: "" })
        expect(result.output).toContain("dismissed")
        expect(result.output).toContain("do NOT start implementing")
        expect(result.output).toContain("question tool")
      }),
    ),
  )
})
