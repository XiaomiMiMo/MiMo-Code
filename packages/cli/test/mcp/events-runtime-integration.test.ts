import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { fileURLToPath } from "node:url"
import { AppLayer } from "../../src/effect/app-runtime"
import { EffectBridge } from "../../src/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { InboxController } from "../../src/inbox"
import { startEvents } from "../../src/mcp/events-runtime"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(AppLayer, CrossSpawnSpawner.defaultLayer, TestLLMServer.layer))
const fixture = fileURLToPath(new URL("./fixtures/events-stdio-server.mjs", import.meta.url))
const config = (url: string) => ({
  enabled_providers: ["alibaba"],
  provider: { alibaba: { options: { apiKey: "test-key", baseURL: url } } },
  agent: { build: { model: "alibaba/qwen-plus" } },
  checkpoint: { thresholds: [] as string[] },
})

const remoteFixture = () => {
  const text = (value: unknown) => `event: message\ndata: ${JSON.stringify(value)}\n\n`
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer example") return new Response(null, { status: 401 })
    const message = await request.json() as { id: number; method: string }
    const response = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result })
    if (message.method === "server/discover") return response({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { extensions: { "io.modelcontextprotocol/events": {} } } })
    if (message.method === "events/list") return response({ resultType: "complete", events: [{ name: "mail.created", delivery: ["push"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } }] })
    if (message.method !== "events/stream") return new Response(null, { status: 404 })
    const meta = { "io.modelcontextprotocol/subscriptionId": message.id }
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(text({ jsonrpc: "2.0", method: "notifications/events/active", params: { cursor: null, _meta: meta } })))
      setTimeout(() => controller.enqueue(new TextEncoder().encode(text({ jsonrpc: "2.0", method: "notifications/events/event", params: { eventId: "remote-id", name: "mail.created", timestamp: "2026-10-30T12:00:00Z", data: { body: "untrusted" }, _meta: meta } }))), 20)
    } }), { headers: { "content-type": "text/event-stream" } })
  } })
}

describe("MCP event session integration", () => {
  it.live("wakes the bound session from a remote authenticated event stream", provideTmpdirServer(({ llm, dir }) => Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(Effect.sync(remoteFixture), (server) => Effect.promise(() => server.stop(true)))
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const bridge = yield* EffectBridge.make()
    const session = yield* sessions.create({ title: "remote-events" })
    yield* llm.text("INITIAL")
    yield* llm.text("REMOTE HANDLED")
    yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "INITIAL PROMPT" }] })
    const close = yield* Effect.promise(() => startEvents({
      server: "remote", config: { type: "remote", url: `${server.url}mcp`, oauth: false, headers: { authorization: "Bearer example" } },
      cwd: dir, allowInsecureLoopback: true, subscriptions: [{ name: "mail.created", sessionID: session.id }], bridge, onError: () => {},
    }))
    yield* Effect.addFinalizer(() => Effect.promise(close))
    yield* llm.wait(2).pipe(Effect.timeout("8 seconds"))
    const request = JSON.stringify((yield* llm.inputs)[1]?.messages)
    expect(request).toContain("External MCP event from")
    expect(request).not.toContain("untrusted")
  }), { git: true, config }), 20_000)
  it.live("accepts a stdio event and wakes the explicitly bound idle session", provideTmpdirServer(({ llm, dir }) => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const controller = yield* InboxController.Service
    const bridge = yield* EffectBridge.make()
    const session = yield* sessions.create({ title: "events" })
    yield* llm.text("INITIAL")
    yield* llm.text("EVENT HANDLED")
    yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "INITIAL PROMPT" }] })
    const errors: string[] = []
    const close = yield* Effect.promise(() => startEvents({
      server: "fixture",
      config: { type: "local", command: [process.execPath, fixture, "normal"] },
      cwd: dir,
      subscriptions: [{ name: "mail.created", sessionID: session.id, arguments: { tag: "session" } }],
      bridge,
      onError: (error) => errors.push(error.message),
    }))
    yield* Effect.addFinalizer(() => Effect.promise(close))
    let found = false
    for (let index = 0; index < 100; index++) {
      const requests = yield* llm.inputs
      if (requests.length >= 2) { found = true; break }
      yield* Effect.sleep("50 millis")
    }
    expect(found).toBe(true)
    const requests = yield* llm.inputs
    const request = JSON.stringify(requests[1]?.messages)
    expect(request).toContain('External MCP event from \\"fixture\\"')
    expect(request).not.toContain('"tag":"session"')
    expect(errors).toEqual([])
    expect((yield* controller.listAccepted({ sessionID: session.id, agentID: "main" })).length).toBeLessThanOrEqual(1)
  }), { git: true, config }), 20_000)

  it.live("does not interrupt an in-flight turn before handling the event", provideTmpdirServer(({ llm, dir }) => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const bridge = yield* EffectBridge.make()
    const session = yield* sessions.create({ title: "busy-events" })
    const release = yield* Deferred.make<void>()
    yield* llm.hold("BUSY DONE", Effect.runPromise(Deferred.await(release)))
    yield* llm.text("EVENT HANDLED")
    const first = yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "BUSY PROMPT" }] }).pipe(Effect.forkChild)
    yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
    const errors: string[] = []
    const close = yield* Effect.promise(() => startEvents({
      server: "fixture", config: { type: "local", command: [process.execPath, fixture, "normal"] }, cwd: dir,
      subscriptions: [{ name: "mail.created", sessionID: session.id, arguments: { tag: "busy" } }], bridge,
      onError: (error) => errors.push(error.message),
    }))
    yield* Effect.addFinalizer(() => Effect.promise(close))
    yield* Effect.sleep("300 millis")
    expect(yield* llm.calls).toBe(1)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    yield* llm.wait(2).pipe(Effect.timeout("8 seconds"))
    expect(JSON.stringify((yield* llm.inputs)[1]?.messages)).toContain('External MCP event from \\"fixture\\"')
    expect(errors).toEqual([])
  }), { git: true, config }), 20_000)
})
