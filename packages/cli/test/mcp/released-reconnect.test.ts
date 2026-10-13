// Issue #2595: a released (closing) connection must not brick its MCP server.
// retire()/close() set `closing` and nothing ever clears it, so a registry that
// still hands out the old handle makes every subsequent call throw
// "MCP connection has been released" until the user reconnects manually.
// The bridge must reconnect on its own: for a stateless server (no session id)
// a fresh connection is trivially equivalent to the dead one.
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { MCP } from "../../src/mcp"
import { McpAuth } from "../../src/mcp/auth"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(MCP.defaultLayer, McpAuth.defaultLayer, CrossSpawnSpawner.defaultLayer))

// Minimal stateless streamable-HTTP MCP server (2026-07-28 transport: no
// session ids — exactly the server shape from the issue). Counts `initialize`
// handshakes so a reconnect is observable end to end.
function makeServer() {
  let initialized = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const msg = (await request.json()) as { id?: number | string; method?: string }
      if (msg.id == null) return new Response(null, { status: 202 })
      let result: unknown
      switch (msg.method) {
        case "initialize":
          initialized++
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: "stateless-fixture", version: "1" },
          }
          break
        case "tools/list":
          result = {
            tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object", properties: {} } }],
          }
          break
        case "tools/call":
          result = { content: [{ type: "text", text: "ok" }] }
          break
        case "prompts/get":
          result = {
            messages: [{ role: "assistant", content: { type: "text", text: "hello" } }],
          }
          break
        default:
          return Response.json({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `unhandled ${msg.method}` },
          })
      }
      return Response.json({ jsonrpc: "2.0", id: msg.id, result })
    },
  })
  const cfg = () => ({
    type: "remote" as const,
    // Bun.serve's url is a URL object; the config schema wants a string.
    url: `${server.url}`,
    oauth: false as const,
    enabled: true,
  })
  return { server, cfg, count: () => initialized, stop: () => server.stop(true) }
}

it.live("prompts fall back to a fresh connection when the pooled handle has been released", () =>
  Effect.gen(function* () {
    const fixture = makeServer()
    yield* Effect.addFinalizer(() => Effect.promise(() => Promise.resolve(fixture.stop())))
    yield* provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("srv", fixture.cfg())
        expect(fixture.count()).toBe(1)

        const first = yield* mcp.getPrompt("srv", "greet")
        expect(first?.messages?.[0]).toMatchObject({ role: "assistant" })

        // refreshHost's replacement path retires the old handle exactly like
        // this; with no turn binding (users === 0) it commits to closing at
        // once. The reported state is this released handle still being what
        // the registry hands back, so inject precisely that.
        const released = (yield* mcp.clients())["srv"]
        expect(released).toBeDefined()
        released!.retire(() => released!.close().then(() => undefined))
        expect((released as unknown as { isClosing: boolean }).isClosing).toBe(true)

        // Every call must recover through a fresh connection instead of
        // throwing "MCP connection has been released" forever.
        const second = yield* mcp.getPrompt("srv", "greet")
        expect(second?.messages?.[0]).toMatchObject({ role: "assistant", content: { text: "hello" } })
        expect(fixture.count()).toBe(2)
        expect((yield* mcp.clients())["srv"]).not.toBe(released)
      }),
    )
  }),
)

it.live("tool calls fall back to a fresh connection when the pooled handle has been released", () =>
  Effect.gen(function* () {
    const fixture = makeServer()
    yield* Effect.addFinalizer(() => Effect.promise(() => Promise.resolve(fixture.stop())))
    yield* provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("srv", fixture.cfg())
        const released = (yield* mcp.clients())["srv"]
        expect(released).toBeDefined()
        released!.retire(() => released!.close().then(() => undefined))

        const tools = yield* mcp.tools()
        const execute = tools["srv_echo"]?.execute
        expect(execute).toBeDefined()
        const result = yield* Effect.promise(() =>
          execute!({}, { toolCallId: "call_1", messages: [], abortSignal: new AbortController().signal }),
        )
        expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] })
        expect(fixture.count()).toBe(2)
      }),
    )
  }),
)

it.live("when reconnecting is impossible the released entry is evicted instead of thrown forever", () =>
  Effect.gen(function* () {
    const fixture = makeServer()
    yield* Effect.addFinalizer(() => Effect.promise(() => Promise.resolve(fixture.stop())))
    yield* provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("srv", fixture.cfg())
        const released = (yield* mcp.clients())["srv"]
        released!.retire(() => released!.close().then(() => undefined))
        // Take the server down so the reconnect attempt cannot succeed.
        fixture.stop()

        const result = yield* mcp.getPrompt("srv", "greet")
        expect(result).toBeUndefined()
        expect((yield* mcp.clients())["srv"]).toBeUndefined()
      }),
    )
  }),
)
