import path from "node:path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import type { Config } from "../../src/config"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, toolCallsResponse, textStopResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, Bus.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

for (const mode of ["permission", "schema"] as const)
  it.live(`a bounded MiMo batch still enforces ${mode} failures before later writes`, () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse([
            {
              id: "first",
              name: mode === "schema" ? "read" : "write",
              args: JSON.stringify(
                mode === "schema" ? { file_path: 123 } : { file_path: "blocked.txt", content: "blocked" },
              ),
            },
            ...Array.from({ length: 19 }, (_, index) => ({
              id: `following-${index}`,
              name: "write",
              args: JSON.stringify({ file_path: `following-${index}.txt`, content: "must not execute" }),
            })),
          ]),
        },
        { lines: textStopResponse("Stopped") },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Bounded batch permissions" })
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Attempt the tools and handle their errors" }],
            })
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools).toHaveLength(16)
            expect(tools.every((part) => part.state.status === "error")).toBe(true)
            expect(tools[0].state.status === "error" && tools[0].state.error).toContain(
              mode === "schema" ? "Invalid arguments" : "specified a rule",
            )
            expect(
              tools
                .slice(1)
                .every(
                  (part) =>
                    part.state.status === "error" &&
                    part.state.error === "Tool call cancelled because an earlier tool call in this response failed.",
                ),
            ).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "blocked.txt")).exists())).toBe(false)
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "following-0.txt")).exists())).toBe(false)
          }),
        {
          git: true,
          config: {
            ...config(server.origin),
            permission: { edit: { "*": "allow", "blocked.txt": "deny" } },
          },
        },
      )
    }),
  )

function config(origin: string): Config.Info {
  return {
    enabled_providers: ["test"],
    model: "test/model",
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "test-key", baseURL: `${origin}/v1` },
        models: {
          model: {
            name: "Test",
            family: "mimo",
            tool_call: true,
            limit: { context: 32000, output: 2000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    permission: { edit: "allow" },
    lsp: false,
    formatter: false,
  }
}

for (const rounds of [1, 3])
  it.live(`${rounds} MiMo batches yield completed tool results instead of regenerating cancelled calls`, () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        ...Array.from({ length: rounds }, (_, round) => ({
          lines: toolCallsResponse(
            Array.from({ length: 20 }, (_, index) => ({
              id: `call-${round}-${index}`,
              name: "write",
              args: JSON.stringify({ file_path: `file-${round}-${index}.txt`, content: "written" }),
            })),
          ),
        })),
        { lines: textStopResponse("Finished") },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Bounded batch" })
            const result = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write the files, then summarize" }],
            })
            expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
            const messages = yield* sessions.messages({ sessionID: session.id })
            const tools = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
            expect(tools).toHaveLength(16 * rounds)
            expect(tools.every((part) => part.state.status === "completed")).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, `file-${rounds - 1}-15.txt`)).text())).toBe(
              "written",
            )
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-0-16.txt")).exists())).toBe(false)
            expect(server.captures).toHaveLength(rounds + 1)
            const continuation = JSON.stringify(server.captures[1].messages)
            expect(continuation).toContain("written")
            expect(continuation).not.toContain("Tool call cancelled because tool-call flooding was detected")
          }),
        { git: true, config: config(server.origin) },
      )
    }),
  )
