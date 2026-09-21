import { describe, expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import type { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import {
  startScriptedLLMServer,
  textStopResponse,
  toolCallResponse,
  toolCallsResponse,
} from "../lib/scripted-llm-server"

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
    agent: { build: { model: "test/model" }, orchestrator: { model: "test/model" } },
    permission: { edit: "allow", bash: "allow" },
    lsp: false,
    formatter: false,
  } satisfies Partial<Config.Info>
}

describe("tool gate orchestration", () => {
  it.live(
    "a non-GPT session join lets its child finish tools in the same directory",
    () =>
      Effect.gen(function* () {
        const response = { lines: [] as string[] }
        const server = startScriptedLLMServer([
          response,
          {
            lines: toolCallResponse({
              id: "child-write",
              name: "write",
              args: JSON.stringify({ file_path: "child.txt", content: "child work" }),
            }),
          },
          { lines: textStopResponse("Finished") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const registry = yield* ActorRegistry.Service
              const parent = yield* sessions.create({ title: "Orchestrator" })
              const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
              yield* registry.register({
                sessionID: child.id,
                actorID: child.id,
                mode: "peer",
                agent: "build",
                description: "Child",
                contextMode: "none",
                background: true,
                lifecycle: "persistent",
              })
              yield* registry.updateStatus(child.id, child.id, { status: "running" })
              response.lines = toolCallResponse({
                id: "parent-join",
                name: "session",
                args: JSON.stringify({
                  operation: { action: "join", sessionIDs: [child.id], timeout_ms: 5000 },
                }),
              })

              const started = yield* Deferred.make<void>()
              const unsubscribe = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
                const part = event.properties.part
                if (
                  part.sessionID === parent.id &&
                  part.type === "tool" &&
                  part.callID === "parent-join" &&
                  part.state.status === "running"
                ) {
                  Deferred.doneUnsafe(started, Effect.void)
                }
              })
              yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
              const joining = yield* prompt
                .prompt({
                  sessionID: parent.id,
                  agent: "orchestrator",
                  harness: "default",
                  parts: [{ type: "text", text: "Join the child" }],
                })
                .pipe(Effect.forkChild)
              yield* Deferred.await(started).pipe(Effect.timeout("10 seconds"))

              // Report terminal state only after the child's real tool and turn finish.
              const writing = yield* prompt
                .prompt({
                  sessionID: child.id,
                  agent: "build",
                  harness: "default",
                  parts: [{ type: "text", text: "Write the file" }],
                })
                .pipe(
                  Effect.tap(() =>
                    registry.updateStatus(child.id, child.id, { status: "idle", lastOutcome: "success" }),
                  ),
                  Effect.forkChild,
                )
              yield* Fiber.join(joining)
              yield* Fiber.join(writing)

              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "child.txt")).text())).toBe("child work")
              const joined = (yield* sessions.messages({ sessionID: parent.id }))
                .flatMap((message) => message.parts)
                .find((part) => part.type === "tool" && part.callID === "parent-join")
              expect(joined?.type).toBe("tool")
              if (joined?.type !== "tool") throw new Error("Missing session join result")
              expect(joined.state.status).toBe("completed")
              if (joined.state.status !== "completed") throw new Error("Session join did not complete")
              expect(joined.state.output).toContain("Join complete")
              expect(joined.state.output).toContain("1 success")
            }),
          { git: true, config: config(server.origin) },
        )
      }),
    20000,
  )

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
                  tools.exec_command({ cmd: "sleep 0.2; printf 'command complete' > ready.txt" }),
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
