import { expect } from "bun:test"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { ToolGate } from "../../src/tool/gate"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, toolCallResponse } from "../lib/scripted-llm-server"

const it = testEffect(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.live(
  "a cancelled queued write never executes when another session releases the gate",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        {
          lines: toolCallResponse({
            id: "call-write",
            name: "write",
            args: JSON.stringify({ file_path: "cancelled.txt", content: "after stop" }),
          }),
        },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const gate = ToolGate.for(dir)
            const held = yield* Effect.promise(() => gate.enter("bash", "other-session"))
            yield* Effect.addFinalizer(() => Effect.sync(() => gate.leave(held)))
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Cancellation" })
            const running = yield* prompt
              .prompt({
                sessionID: session.id,
                agent: "build",
                harness: "default",
                parts: [{ type: "text", text: "Write the file" }],
              })
              .pipe(Effect.forkChild)
            yield* Effect.promise(async () => {
              const deadline = Date.now() + 10000
              while (gate.queuedCount === 0 && Date.now() < deadline) await Bun.sleep(10)
            })
            expect(gate.queuedCount).toBe(1)
            yield* prompt.cancel(session.id)
            const result = yield* Fiber.join(running)
            expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageAbortedError")
            expect(gate.queuedCount).toBe(0)
            gate.leave(held)
            // A later barrier must finish without resurrecting the cancelled write.
            const next = yield* Effect.promise(() => gate.enter("bash", "after-cancel"))
            gate.leave(next)
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "cancelled.txt")).exists())).toBe(false)
            expect(gate.runningCount).toBe(0)
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
            permission: { edit: "allow" },
            lsp: false,
            formatter: false,
          },
        },
      )
    }),
  20000,
)
