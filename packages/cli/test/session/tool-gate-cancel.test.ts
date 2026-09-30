import { expect, spyOn } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Question } from "../../src/question"
import { MessageV2 } from "../../src/session/message-v2"
import { ToolGate } from "../../src/tool/gate"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, toolCallsResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    Question.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

it.live(
  "a cancelled write queued behind a question in the same step never executes",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse([
            {
              id: "ask-user",
              name: "question",
              args: JSON.stringify({ questions: [{ question: "Continue?", header: "Continue", options: [] }] }),
            },
            {
              id: "call-write",
              name: "write",
              args: JSON.stringify({ file_path: "cancelled.txt", content: "after stop" }),
            },
          ]),
        },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Cancellation" })
            const bus = yield* Bus.Service
            const questions = yield* Question.Service
            // Observe actual release without replacing the gate implementation.
            const leaving = spyOn(ToolGate.prototype, "leave")
            yield* Effect.addFinalizer(() => Effect.sync(() => leaving.mockRestore()))
            const asked = yield* Deferred.make<void>()
            const queued = yield* Deferred.make<void>()
            const unsubscribeAsked = yield* bus.subscribeCallback(Question.Event.Asked, (event) => {
              if (event.properties.sessionID === session.id) Deferred.doneUnsafe(asked, Effect.void)
            })
            const unsubscribeQueued = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
              const part = event.properties.part
              if (
                part.sessionID === session.id &&
                part.type === "tool" &&
                part.callID === "call-write" &&
                part.state.status === "running"
              ) {
                Deferred.doneUnsafe(queued, Effect.void)
              }
            })
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribeAsked))
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribeQueued))
            yield* Effect.addFinalizer(() =>
              questions
                .list()
                .pipe(
                  Effect.flatMap((pending) =>
                    Effect.forEach(pending, (question) => questions.reject(question.id), { discard: true }),
                  ),
                ),
            )
            yield* Effect.addFinalizer(() => prompt.cancel(session.id))
            const running = yield* prompt
              .prompt({
                sessionID: session.id,
                agent: "build",
                harness: "default",
                parts: [{ type: "text", text: "Write the file" }],
              })
              .pipe(Effect.forkChild)
            yield* Deferred.await(asked).pipe(Effect.timeout("10 seconds"))
            yield* Deferred.await(queued).pipe(Effect.timeout("10 seconds"))
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "cancelled.txt")).exists())).toBe(false)
            yield* prompt.cancel(session.id)
            const result = yield* Fiber.join(running)
            expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageAbortedError")
            // Base question cancellation is unchanged. End its outstanding wait
            // explicitly, then let the old batch drain before checking for writes.
            yield* Effect.forEach(yield* questions.list(), (question) => questions.reject(question.id), { discard: true })
            yield* Effect.promise(async () => {
              while (true) {
                const index = leaving.mock.calls.findIndex(([token]) => token.startsWith("ask-user#"))
                const gate = leaving.mock.contexts[index]
                if (gate instanceof ToolGate && gate.runningCount === 0 && gate.queuedCount === 0) return
                await Bun.sleep(10)
              }
            }).pipe(Effect.timeout("1 second"))
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "cancelled.txt")).exists())).toBe(false)
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools).toHaveLength(2)
            expect(tools.every((part) => part.state.status === "error")).toBe(true)
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
            agent: { build: { model: "test/model" } },
            permission: { edit: "allow", question: "allow" },
            lsp: false,
            formatter: false,
          },
        },
      )
    }),
  20000,
)
