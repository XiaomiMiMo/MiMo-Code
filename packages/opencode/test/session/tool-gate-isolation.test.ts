import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import {
  startScriptedLLMServer,
  textStopResponse,
  toolCallResponse,
  toolCallsResponse,
} from "../lib/scripted-llm-server"

const it = testEffect(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

for (const peer of ["agent", "session"] as const) {
  it.live(
    `a custom tool can wait for another ${peer} in the same directory without sharing its gate`,
    () =>
      Effect.gen(function* () {
        const server = startScriptedLLMServer([
          {
            lines: toolCallsResponse([
              { id: "wait-for-peer", name: "talk_to_session", args: "{}" },
              {
                id: "after-wait",
                name: "write",
                args: JSON.stringify({ file_path: "after.txt", content: "after reply" }),
              },
            ]),
          },
          {
            lines: toolCallResponse({
              id: "peer-write",
              name: "write",
              args: JSON.stringify({ file_path: "reply.txt", content: "peer reply" }),
            }),
          },
          { lines: textStopResponse("Finished") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              // A real file-loaded custom tool with no scheduling metadata. Its
              // wait represents a desktop bridge waiting for another agent.
              yield* Effect.promise(async () => {
                await fs.mkdir(path.join(dir, ".mimocode", "tools"), { recursive: true })
                await fs.writeFile(
                  path.join(dir, ".mimocode", "tools", "talk_to_session.ts"),
                  `import fs from "node:fs/promises"
import path from "node:path"
export default {
  description: "Wait for a peer reply",
  args: {},
  async execute(args, ctx) {
    await fs.writeFile(path.join(ctx.directory, "waiting.txt"), "waiting")
    while (true) {
      ctx.abort.throwIfAborted()
      const reply = await fs.readFile(path.join(ctx.directory, "reply.txt"), "utf8").catch(() => undefined)
      if (reply) return reply
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}`,
                )
              })
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const parent = yield* sessions.create({ title: "Waiting agent" })
              const child = peer === "session" ? yield* sessions.create({ title: "Peer session" }) : parent
              yield* Effect.addFinalizer(() => prompt.cancel(parent.id))
              yield* Effect.addFinalizer(() => prompt.cancel(child.id))
              const waiting = yield* prompt
                .prompt({
                  sessionID: parent.id,
                  agent: "build",
                  harness: "default",
                  parts: [{ type: "text", text: "Wait for the peer, then write" }],
                })
                .pipe(Effect.forkChild)
              yield* Effect.promise(async () => {
                while (!(await Bun.file(path.join(dir, "waiting.txt")).exists())) await Bun.sleep(10)
              }).pipe(Effect.timeout("10 seconds"))
              // The custom call holds this agent's gate; its next write must wait.
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "after.txt")).exists())).toBe(false)
              yield* prompt
                .prompt({
                  sessionID: child.id,
                  ...(peer === "agent" ? { agentID: "build-peer", source: "spawn" as const } : {}),
                  agent: "build",
                  harness: "default",
                  parts: [{ type: "text", text: "Write the peer reply" }],
                })
                .pipe(Effect.timeout("10 seconds"))
              yield* Fiber.join(waiting).pipe(Effect.timeout("10 seconds"))
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "after.txt")).text())).toBe("after reply")
              const result = (yield* sessions.messages({ sessionID: parent.id, agentID: "main" }))
                .flatMap((message) => message.parts)
                .find((part) => part.type === "tool" && part.callID === "wait-for-peer")
              expect(result).toMatchObject({ state: { status: "completed", output: "peer reply" } })
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
