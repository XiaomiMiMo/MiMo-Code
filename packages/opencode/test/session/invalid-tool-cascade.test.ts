import path from "node:path"
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import type { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
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
const cancelled = "Tool call cancelled because an earlier tool call in this response failed."

const calls = [
  { name: "Bash", args: { command: "printf executed > original-marker.txt", description: "Create local marker" } },
  { name: "Grep", args: { pattern: "original", path: "." } },
  { name: "Read", args: { file_path: "source.txt" } },
  { name: "Write", args: { file_path: "original-marker.txt", content: "executed" } },
]

for (const entry of [
  ...calls.map((call) => ({ ...call, disable: undefined, flooding: undefined, prefix: false })),
  ...["1", "true"].map((disable) => ({ ...calls[1], disable, flooding: undefined, prefix: false })),
  { ...calls[1], disable: undefined, flooding: "1", prefix: false },
  { ...calls[1], disable: undefined, flooding: undefined, prefix: true },
  { ...calls[1], disable: undefined, flooding: undefined, prefix: false, whitelist: true },
  { name: "read", args: { file_path: 123 }, disable: undefined, flooding: undefined, prefix: false, whitelist: true },
  {
    name: "read",
    args: { file_path: 123 },
    disable: undefined,
    flooding: undefined,
    prefix: false,
    whitelist: true,
    deny: true,
  },
])
  it.live(
    entry.disable
      ? `cascade opt-out ${entry.disable} preserves the invalid ${entry.name} result and executes the following write`
      : `invalid ${entry.name} handles later calls${"whitelist" in entry ? " with an actor whitelist" : ""}${"deny" in entry ? " excluding read" : ""}${entry.flooding ? " with flooding protection disabled" : ""}${entry.prefix ? " and preserves earlier successful writes" : ""}`,
    () =>
      Effect.gen(function* () {
        const previous = {
          cascade: process.env.MIMOCODE_DISABLE_FAIL_CASCADE,
          flooding: process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT,
        }
        delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
        delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
        if (entry.disable) process.env.MIMOCODE_DISABLE_FAIL_CASCADE = entry.disable
        if (entry.flooding) process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = entry.flooding
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous.cascade == null) delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
            else process.env.MIMOCODE_DISABLE_FAIL_CASCADE = previous.cascade
            if (previous.flooding == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
            else process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = previous.flooding
          }),
        )
        const server = startScriptedLLMServer([
          {
            lines: toolCallsResponse([
              ...(entry.prefix
                ? [
                    {
                      id: "successful-prefix",
                      name: "write",
                      args: JSON.stringify({ file_path: "prefix.txt", content: "prefix retained" }),
                    },
                  ]
                : []),
              { id: "bad-name", name: entry.name, args: JSON.stringify(entry.args) },
              {
                id: "following-call",
                name: "write",
                args: JSON.stringify({ file_path: "tail-marker.txt", content: "tail executed" }),
              },
            ]),
          },
          { lines: textStopResponse("Recovered") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => Bun.write(path.join(dir, "source.txt"), "original"))
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "Invalid tool cascade" })
              if ("whitelist" in entry) {
                const registry = yield* ActorRegistry.Service
                yield* registry.register({
                  sessionID: session.id,
                  actorID: "test-actor",
                  mode: "peer",
                  agent: "build",
                  description: "Whitelisted actor",
                  contextMode: "none",
                  tools: "deny" in entry ? ["write"] : ["read", "write"],
                  background: false,
                  lifecycle: "persistent",
                })
              }
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agentID: "whitelist" in entry ? "test-actor" : undefined,
                agent: "build",
                harness: "default",
                parts: [{ type: "text", text: "Run the requested tools and recover from errors" }],
              })
              const tools = (yield* sessions.messages({
                sessionID: session.id,
                agentID: "whitelist" in entry ? "test-actor" : undefined,
              }))
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool")
              expect(tools).toHaveLength(entry.prefix ? 3 : 2)
              const bad = tools.find((part) => part.callID === "bad-name")!
              expect(bad.tool).toBe(entry.name === "read" ? "read" : "invalid")
              if (entry.name !== "read") expect(bad.state.input.tool).toBe(entry.name)
              expect(bad.state.status).toBe("deny" in entry ? "completed" : "error")
              const failure =
                bad.state.status === "error"
                  ? bad.state.error
                  : bad.state.status === "completed"
                    ? bad.state.output
                    : ""
              expect(failure).toContain(entry.name)
              expect(failure).toMatch("deny" in entry ? /whitelist/ : /unknown|unavailable|invalid|not available/i)
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "original-marker.txt")).exists())).toBe(false)
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "tail-marker.txt")).exists())).toBe(
                Boolean(entry.disable),
              )
              expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
              expect(result.parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(true)
              expect(server.captures).toHaveLength(2)
              const continuation = JSON.stringify(server.captures[1].messages)
              expect(continuation).toContain("bad-name")
              expect(continuation).toContain(entry.name)
              if (entry.prefix) {
                expect(tools.find((part) => part.callID === "successful-prefix")?.state.status).toBe("completed")
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, "prefix.txt")).text())).toBe(
                  "prefix retained",
                )
                expect(continuation).toContain("successful-prefix")
                expect(continuation).toContain("prefix.txt")
              }
              if (entry.disable) {
                expect(tools.find((part) => part.callID === "following-call")?.state.status).toBe("completed")
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, "tail-marker.txt")).text())).toBe(
                  "tail executed",
                )
                expect(continuation).toContain("following-call")
                expect(continuation).toContain("tail-marker.txt")
                return
              }
              const tail = tools.find((part) => part.callID === "following-call")!
              expect(tail.state.status === "error" && tail.state.error).toBe(cancelled)
              expect(continuation).toContain("following-call")
              expect(continuation).toContain("tail-marker.txt")
              expect(continuation).toContain(cancelled)
            }),
          { git: true, config: config(server.origin) },
        )
      }),
    30000,
  )

it.live(
  "invalid tools keep the provider stream open and preserve cached usage and cancelled observations",
  () =>
    Effect.gen(function* () {
      const previous = {
        cascade: process.env.MIMOCODE_DISABLE_FAIL_CASCADE,
        flooding: process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT,
      }
      delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
      delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous.cascade == null) delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
          else process.env.MIMOCODE_DISABLE_FAIL_CASCADE = previous.cascade
          if (previous.flooding == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
          else process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = previous.flooding
        }),
      )
      let controller!: ReadableStreamDefaultController<Uint8Array>
      let sourceCancelled = false
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
        },
        cancel() {
          sourceCancelled = true
        },
      })
      const lines = toolCallsResponse([
        { id: "bad-name", name: "Grep", args: JSON.stringify({ pattern: "original", path: "." }) },
        {
          id: "cancelled-tail",
          name: "write",
          args: JSON.stringify({ file_path: "marker.txt", content: "must not execute" }),
        },
      ])
      const server = startScriptedLLMServer([{ lines: [], stream }, { lines: textStopResponse("Recovered") }])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Invalid tool stream usage" })
            const observed = yield* Deferred.make<void>()
            const unsubscribe = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
              const part = event.properties.part
              if (part.sessionID === session.id && part.type === "tool" && part.callID === "bad-name")
                Deferred.doneUnsafe(observed, Effect.void)
            })
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
            yield* Effect.addFinalizer(() => prompt.cancel(session.id))
            const running = yield* prompt
              .prompt({
                sessionID: session.id,
                agent: "build",
                harness: "default",
                parts: [{ type: "text", text: "Run the tools and recover from errors" }],
              })
              .pipe(Effect.forkChild)
            for (const line of lines.slice(0, -2)) controller.enqueue(new TextEncoder().encode(line))
            yield* Deferred.await(observed).pipe(Effect.timeout("10 seconds"))
            yield* Effect.sleep("100 millis")
            expect(sourceCancelled).toBe(false)
            expect(server.captures).toHaveLength(1)
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "marker.txt")).exists())).toBe(false)
            controller.enqueue(new TextEncoder().encode(lines.at(-2)))
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  id: "chatcmpl-stub",
                  object: "chat.completion.chunk",
                  choices: [],
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 10,
                    total_tokens: 110,
                    prompt_tokens_details: { cached_tokens: 80 },
                  },
                })}\n\n`,
              ),
            )
            controller.enqueue(new TextEncoder().encode(lines.at(-1)))
            controller.close()
            const result = yield* Fiber.join(running)
            const messages = yield* sessions.messages({ sessionID: session.id })
            const first = messages.find((message) =>
              message.parts.some((part) => part.type === "tool" && part.callID === "bad-name"),
            )!
            expect(first.info.role === "assistant" && first.info.tokens.cache.read).toBe(80)
            expect(first.info.role === "assistant" && first.info.tokens.output).toBe(10)
            const tools = first.parts.filter((part) => part.type === "tool")
            expect(tools).toHaveLength(2)
            const bad = tools.find((part) => part.callID === "bad-name")!
            const tail = tools.find((part) => part.callID === "cancelled-tail")!
            expect(bad.tool).toBe("invalid")
            expect(bad.state.input.tool).toBe("Grep")
            expect(bad.state.status === "error" && bad.state.error).toContain("Grep")
            expect(tail.state.status === "error" && tail.state.error).toBe(cancelled)
            expect(sourceCancelled).toBe(false)
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "marker.txt")).exists())).toBe(false)
            expect(server.captures).toHaveLength(2)
            const continuation = JSON.stringify(server.captures[1].messages)
            expect(continuation).toContain("bad-name")
            expect(continuation).toContain("Grep")
            expect(continuation).toContain("cancelled-tail")
            expect(continuation).toContain(cancelled)
            expect(result.parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(true)
          }),
        { git: true, config: config(server.origin) },
      )
    }),
  30000,
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
