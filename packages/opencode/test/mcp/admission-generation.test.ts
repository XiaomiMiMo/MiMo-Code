// [TP-MCU-R7-21][TP-MCU-R10-20] Host admission: stale generation failure cannot invalidate newer host.
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { MCP } from "../../src/mcp"
import { HostMcp } from "../../src/mcp/host"
import { McpAuth } from "../../src/mcp/auth"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(MCP.defaultLayer, McpAuth.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.live("[TP-MCU-R7-21][TP-MCU-R10-20] old generation failure cannot invalidate newer host", () =>
  Effect.gen(function* () {
    let release!: () => void
    let entered!: () => void
    let oldLists = 0
    const blocked = new Promise<void>((r) => (release = r))
    const started = new Promise<void>((r) => (entered = r))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        release()
        HostMcp.set({})
      }),
    )
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            if (request.method !== "POST") return new Response(null, { status: 405 })
            const msg = (await request.json()) as { id?: number | string; method?: string }
            if (msg.id == null) return new Response(null, { status: 202 })
            const name = new URL(request.url).pathname === "/old" ? "old" : "new"
            if (msg.method === "tools/list" && name === "old" && ++oldLists === 2) {
              entered()
              await blocked
              return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "stale" } })
            }
            const result =
              msg.method === "initialize"
                ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version: "1" } }
                : { tools: [{ name, inputSchema: { type: "object" } }] }
            return Response.json({ jsonrpc: "2.0", id: msg.id, result })
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const cfg = (endpoint: string) => ({
      type: "remote" as const,
      url: `${server.url}${endpoint}`,
      oauth: false as const,
      enabled: true,
    })
    HostMcp.set({ example: cfg("old") })
    yield* provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect(Object.keys(yield* mcp.tools())).toEqual(["example_old"])
        const pending = yield* mcp.connect("example").pipe(Effect.forkChild)
        yield* Effect.promise(() => started)
        HostMcp.set({ example: cfg("new") })
        yield* mcp.tools()
        expect(Object.keys(yield* mcp.tools())).toEqual(["example_new"])
        release()
        yield* Fiber.join(pending)
        expect(Object.keys(yield* mcp.tools())).toEqual(["example_new"])
      }),
    )
  }),
)
