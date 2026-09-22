import path from "node:path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, toolCallsResponse, textStopResponse } from "../lib/scripted-llm-server"

const it = testEffect(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

for (const disableFlooding of [false, true]) {
  for (const disableCascade of [false, true]) {
    it.live(
      `flag matrix: flooding protection=${!disableFlooding}, failure cascade=${!disableCascade}`,
      () =>
        Effect.gen(function* () {
          const previous = {
            flooding: process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT,
            cascade: process.env.MIMOCODE_DISABLE_FAIL_CASCADE,
          }
          if (disableFlooding) process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = "true"
          else delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
          if (disableCascade) process.env.MIMOCODE_DISABLE_FAIL_CASCADE = "true"
          else delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (previous.flooding == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
              else process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = previous.flooding
              if (previous.cascade == null) delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
              else process.env.MIMOCODE_DISABLE_FAIL_CASCADE = previous.cascade
            }),
          )
          const batches = [17, 3].map((count, batch) =>
            Array.from({ length: count }, (_, index) => ({
              id: `batch-${batch}-call-${index}`,
              name: index === 1 ? "edit" : "write",
              args: JSON.stringify(
                index === 1
                  ? { file_path: "missing.txt", old_string: "old", new_string: "new" }
                  : { file_path: `batch-${batch}-file-${index}.txt`, content: "written" },
              ),
            })),
          )
          const server = startScriptedLLMServer([
            ...batches.map((batch) => ({ lines: toolCallsResponse(batch) })),
            { lines: textStopResponse("Finished") },
          ])
          yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
          yield* provideTmpdirInstance(
            (dir) =>
              Effect.gen(function* () {
                const prompt = yield* SessionPrompt.Service
                const sessions = yield* Session.Service
                const session = yield* sessions.create({ title: "Independent tool safety flags" })
                const result = yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  harness: "default",
                  parts: [{ type: "text", text: "Run both batches" }],
                })
                const tools = (yield* sessions.messages({ sessionID: session.id }))
                  .flatMap((message) => message.parts)
                  .filter((part) => part.type === "tool")
                expect(tools).toHaveLength(20)
                for (const batch of [0, 1]) {
                  const parts = tools.filter((part) => part.callID.startsWith(`batch-${batch}-`))
                  const flooded = batch === 0 && !disableFlooding
                  expect(
                    yield* Effect.promise(() => Bun.file(path.join(dir, `batch-${batch}-file-0.txt`)).exists()),
                  ).toBe(true)
                  expect(
                    yield* Effect.promise(() => Bun.file(path.join(dir, `batch-${batch}-file-2.txt`)).exists()),
                  ).toBe(!flooded && disableCascade)
                  expect(parts[0].state.status).toBe("completed")
                  if (flooded) {
                    expect(
                      parts
                        .slice(1)
                        .every(
                          (part) =>
                            part.state.status === "error" &&
                            part.state.error === "Tool call cancelled because tool-call flooding was detected.",
                        ),
                    ).toBe(true)
                    continue
                  }
                  expect(parts[1].state.status).toBe("error")
                  expect(parts[1].state.status === "error" && parts[1].state.error).toContain("not found")
                  expect(
                    parts
                      .slice(2)
                      .every((part) =>
                        disableCascade
                          ? part.state.status === "completed"
                          : part.state.status === "error" &&
                            part.state.error ===
                              "Tool call cancelled because an earlier tool call in this response failed.",
                      ),
                  ).toBe(true)
                }
                expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
                expect(result.parts.some((part) => part.type === "text" && part.text === "Finished")).toBe(true)
                expect(server.captures).toHaveLength(3)
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
      30000,
    )
  }
}
