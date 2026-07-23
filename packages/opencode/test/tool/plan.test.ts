import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "../../src/tool"
import { PlanEnterTool, PlanExitTool } from "../../src/tool/plan"
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

  it.live("plan_exit rejecting (Esc) still fails with QuestionRejectedError", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const question = yield* Question.Service
        const info = yield* sessions.create({ title: "Test" })
        const tool = yield* (yield* PlanExitTool).init()

        const fiber = yield* tool.execute({}, ctx(info.id, "plan")).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        yield* question.reject(item.id)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.stringify(exit)).toContain("QuestionRejectedError")
      }),
    ),
  )

  it.live("plan_enter answering No resolves with stay-in-current-mode guidance", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const question = yield* Question.Service
        const info = yield* sessions.create({ title: "Test" })
        const tool = yield* (yield* PlanEnterTool).init()

        const fiber = yield* tool.execute({}, ctx(info.id, "build")).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        yield* question.reply({ requestID: item.id, answers: [["No"]] })

        const result = yield* Fiber.join(fiber)
        expect(result.metadata).toMatchObject({ switched: false, feedback: "" })
        expect(result.output).toContain("NOT to switch to plan mode")
        expect(result.output).toContain("continue the current task")
      }),
    ),
  )
})
