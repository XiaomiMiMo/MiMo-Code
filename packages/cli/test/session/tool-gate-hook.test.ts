import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, toolCallResponse, textStopResponse } from "../lib/scripted-llm-server"

const it = testEffect(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, CrossSpawnSpawner.defaultLayer))
it.live(
  "path rewrite hooks preserve the FIFO order of writes to one destination",
  () =>
    Effect.gen(function* () {
      const first = toolCallResponse({
        id: "first",
        name: "write",
        args: JSON.stringify({ file_path: "logical.txt", content: "first" }),
      })
      const second = toolCallResponse({
        id: "second",
        name: "write",
        args: JSON.stringify({ file_path: "target.txt", content: "second" }),
      })
      const server = startScriptedLLMServer([
        {
          lines: [
            first[0],
            first[1],
            first[2],
            second[1].replaceAll('"index":0', '"index":1'),
            second[2].replaceAll('"index":0', '"index":1'),
            first[3],
            first[4],
          ],
        },
        { lines: textStopResponse("Finished") },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(dir, ".mimocode", "hooks"), { recursive: true })
              await fs.writeFile(
                path.join(dir, ".mimocode", "hooks", "redirect.ts"),
                `export default {
        "tool.execute.before": async (input, output) => {
          if (input.tool !== "write" || output.args.file_path !== "logical.txt") return
          output.args.file_path = "target.txt"
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }`,
              )
            })
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({ title: "Hook path rewrite" })
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write both files in order" }],
            })
            const content = yield* Effect.promise(() => fs.readFile(path.join(dir, "target.txt"), "utf8"))
            expect(content).toBe("second")
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
