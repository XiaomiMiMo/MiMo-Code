import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { ActorRegistry } from "../../src/actor/registry"
import type { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, textStopResponse, toolCallsResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    ActorRegistry.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

function config(origin: string) {
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
  } satisfies Partial<Config.Info>
}

describe("tool gate orchestration", () => {
  it.live(
    "top-level Codex exec calls serialize while each script retains Promise.all",
    () =>
      Effect.gen(function* () {
        const server = startScriptedLLMServer([
          {
            lines: toolCallsResponse([
              {
                id: "exec-call",
                name: "exec",
                args: JSON.stringify({
                  code: `return await Promise.all([
                  tools.apply_patch({ patch_text: "*** Begin Patch\\n*** Add File: example.txt\\n+example\\n*** End Patch" }),
                  tools.exec_command({ cmd: "sleep 0.2; printf \'command complete\' > ready.txt" }),
                ])`,
                }),
              },
              {
                id: "next-exec",
                name: "exec",
                args: JSON.stringify({ code: 'return await tools.exec_command({ cmd: "cat ready.txt" })' }),
              },
            ]),
          },
          { lines: textStopResponse("Finished") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "Exec ordering" })
              yield* prompt
                .prompt({
                  sessionID: session.id,
                  agent: "build",
                  harness: "codex",
                  parts: [{ type: "text", text: "Run the independent tools" }],
                })
                .pipe(Effect.timeout("10 seconds"))
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "example.txt")).text())).toBe("example\n")
              const execution = (yield* sessions.messages({ sessionID: session.id }))
                .flatMap((message) => message.parts)
                .find((part) => part.type === "tool" && part.callID === "exec-call")
              expect(execution?.type).toBe("tool")
              if (execution?.type !== "tool") throw new Error("Missing exec result")
              expect(execution.state.status).toBe("completed")
              if (execution.state.status !== "completed") throw new Error("Exec did not complete")
              expect(execution.state.metadata.status).toBe("completed")
              expect(execution.state.metadata.toolCalls).toBe(2)
              const next = (yield* sessions.messages({ sessionID: session.id }))
                .flatMap((message) => message.parts)
                .find((part) => part.type === "tool" && part.callID === "next-exec")
              expect(next?.type).toBe("tool")
              if (next?.type !== "tool" || next.state.status !== "completed")
                throw new Error("Missing next exec result")
              expect(next.state.output).toContain("command complete")
            }),
          { git: true, config: config(server.origin) },
        )
      }),
    20000,
  )
})
