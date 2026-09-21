import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ToolGate } from "../../src/tool/gate"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, toolCallResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    Question.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

for (const tool of ["question", "plan_exit"] as const) {
  it.live(
    `session cancellation dismisses an admitted ${tool} and releases its barrier`,
    () =>
      Effect.gen(function* () {
        const server = startScriptedLLMServer([
          {
            lines: toolCallResponse({
              id: "ask-user",
              name: tool,
              args: JSON.stringify(
                tool === "question"
                  ? {
                      questions: [{ question: "Which option?", header: "Option", options: [] }],
                    }
                  : {},
              ),
            }),
          },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const questions = yield* Question.Service
              const bus = yield* Bus.Service
              const session = yield* sessions.create({ title: "Question cancellation" })
              const gate = ToolGate.for(dir)
              const asked = yield* Deferred.make<void>()
              const rejected = yield* Deferred.make<void>()
              const unsubscribeAsked = yield* bus.subscribeCallback(Question.Event.Asked, (event) => {
                if (event.properties.sessionID === session.id) Deferred.doneUnsafe(asked, Effect.void)
              })
              const unsubscribeRejected = yield* bus.subscribeCallback(Question.Event.Rejected, (event) => {
                if (event.properties.sessionID === session.id) Deferred.doneUnsafe(rejected, Effect.void)
              })
              yield* Effect.addFinalizer(() => Effect.sync(unsubscribeAsked))
              yield* Effect.addFinalizer(() => Effect.sync(unsubscribeRejected))
              yield* Effect.addFinalizer(() =>
                questions
                  .list()
                  .pipe(
                    Effect.flatMap((pending) =>
                      Effect.forEach(pending, (question) => questions.reject(question.id), { discard: true }),
                    ),
                  ),
              )
              const running = yield* prompt
                .prompt({
                  sessionID: session.id,
                  agent: tool === "plan_exit" ? "plan" : "build",
                  harness: "default",
                  parts: [{ type: "text", text: "Ask the user" }],
                })
                .pipe(Effect.forkChild)
              yield* Deferred.await(asked).pipe(Effect.timeout("10 seconds"))
              expect(gate.runningCount).toBe(1)
              yield* prompt.cancel(session.id)
              const result = yield* Fiber.join(running)
              expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageAbortedError")
              expect(
                (yield* sessions.messages({ sessionID: session.id }))
                  .flatMap((message) => message.parts)
                  .find((part) => part.type === "tool" && part.callID === "ask-user"),
              ).toMatchObject({ state: { status: "error" } })
              yield* Deferred.await(rejected).pipe(Effect.timeout("1 second"))
              expect(yield* questions.list()).toHaveLength(0)
              yield* gate.run("read", "next-session", Effect.void).pipe(Effect.timeout("1 second"))
              expect(gate.runningCount).toBe(0)
              expect(gate.queuedCount).toBe(0)
            }),
          {
            git: true,
            config: {
              enabled_providers: ["test"],
              model: "test/model",
              provider: {
                test: {
                  npm: "@ai-sdk/openai-compatible",
                  env: [],
                  options: { apiKey: "test-key", baseURL: `${server.origin}/v1` },
                  models: {
                    model: {
                      name: "Test",
                      tool_call: true,
                      limit: { context: 32000, output: 2000 },
                      modalities: { input: ["text"], output: ["text"] },
                    },
                  },
                },
              },
              agent: { build: { model: "test/model" }, plan: { model: "test/model" } },
              permission: { edit: "allow", question: "allow" },
              lsp: false,
              formatter: false,
            },
          },
        )
      }),
    20000,
  )
}
