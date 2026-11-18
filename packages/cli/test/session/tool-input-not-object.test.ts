import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ActorRegistry } from "../../src/actor/registry"
import type { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { PartTable } from "../../src/session/session.sql"
import { Database } from "../../src/storage"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, textStopResponse, toolCallsResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    ActorRegistry.defaultLayer,
  ),
)

const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

describe("tool call arguments that are not a JSON object", () => {
  // A model can emit a bare number/string/boolean/array where the provider
  // protocol wants an object. `ToolState.input` is a record, so the value has to
  // be coerced before the part is written; otherwise the write is rejected and
  // the whole turn dies on a ZodError that is never retried.
  for (const args of ["71", '"hello"', "[1,2]", "true"]) {
    it.live(
      `persists an empty record and recovers from ${args}`,
      () =>
        Effect.gen(function* () {
          const server = startScriptedLLMServer([
            { lines: toolCallsResponse([{ id: "bad-input", name: "read", args }]) },
            { lines: textStopResponse("Recovered") },
          ])
          yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
          yield* provideTmpdirInstance(
            (dir) =>
              Effect.gen(function* () {
                yield* Effect.promise(() => Bun.write(path.join(dir, "source.txt"), "original"))
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "Non-object tool input" })
                const result = yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  harness: "default",
                  parts: [{ type: "text", text: "Read the file" }],
                })
                const tools = (yield* sessions.messages({ sessionID: session.id }))
                  .flatMap((message) => message.parts)
                  .filter((part) => part.type === "tool")
                expect(tools).toHaveLength(1)
                const part = tools[0]!
                expect(part.state.input).toEqual({})
                expect(part.state.status).toBe("error")
                if (part.state.status === "error") {
                  expect(part.state.error).toContain("read")
                  expect(part.state.metadata?.recoverable).toBe(true)
                }
                // The turn survives: the model sees the rejected call and answers.
                expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
                expect(result.parts.some((p) => p.type === "text" && p.text === "Recovered")).toBe(true)
                expect(server.captures).toHaveLength(2)
              }),
            { git: true, config: config(server.origin) },
          )
        }),
      30000,
    )
  }
})

describe("already-persisted tool parts with a non-object input", () => {
  // Rows written by an older build, a legacy JSON-storage migration, or an
  // imported session outlive the fix. Validation must not let one of them make
  // the session unopenable.
  for (const status of ["completed", "running"] as const) {
    it.live(
      `loads and mutates a ${status} row instead of throwing`,
      () =>
        Effect.gen(function* () {
          yield* provideTmpdirInstance(
            () =>
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const info = yield* sessions.create({ title: "Legacy malformed tool part" })
                const user = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user",
                  sessionID: info.id,
                  agent: "build",
                  model,
                  time: { created: Date.now() },
                })
                const assistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant",
                  sessionID: info.id,
                  agent: "build",
                  mode: "build",
                  parentID: user.id,
                  modelID: model.modelID,
                  providerID: model.providerID,
                  path: { cwd: "/tmp/example", root: "/tmp/example" },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  time: { created: Date.now() },
                } as MessageV2.Assistant)
                const partID = PartID.ascending()
                const stored = {
                  type: "tool",
                  tool: "bash",
                  callID: "call_legacy",
                  state: {
                    status,
                    input: 71,
                    ...(status === "completed"
                      ? { output: "Empty tool arguments.", title: "", metadata: {}, time: { start: 1, end: 2 } }
                      : { time: { start: 1 } }),
                  },
                }
                Database.use((db) =>
                  db
                    .insert(PartTable)
                    .values({
                      id: partID,
                      message_id: assistant.id,
                      session_id: info.id,
                      time_created: Date.now(),
                      data: stored as unknown as MessageV2.Part,
                    })
                    .run(),
                )

                const loaded = yield* sessions.getPart({ sessionID: info.id, messageID: assistant.id, partID })
                expect(loaded?.type === "tool" && loaded.state.input).toEqual({})

                const message = (yield* sessions.messages({ sessionID: info.id })).find(
                  (item) => item.info.id === assistant.id,
                )!
                const part = message.parts.find((item) => item.id === partID)!
                expect(part.type === "tool" && part.state.input).toEqual({})

                // `mutateToolPart` re-parses the row, and is what the resume sweep
                // and every live tool update go through.
                const mutated = yield* sessions.mutateToolPart(
                  { sessionID: info.id, messageID: assistant.id, partID },
                  (current) => current,
                )
                expect(mutated?.state.input).toEqual({})
              }),
            { git: true },
          )
        }),
      30000,
    )
  }
})

describe("toolInput", () => {
  it.live("keeps a record and rejects every other JSON shape", () =>
    Effect.sync(() => {
      const input = { command: "ls" }
      expect(MessageV2.toolInput(input)).toBe(input)
      for (const value of [71, 7.6, "str", true, null, undefined, [1, 2], [{ a: 1 }]]) {
        expect(MessageV2.toolInput(value)).toEqual({})
      }
    }),
  )
})

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
            tool_call: true,
            limit: { context: 32000, output: 2000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agent: { build: { model: "test/model" } },
    permission: { edit: "allow", bash: "allow" },
    lsp: false,
    formatter: false,
  }
}
