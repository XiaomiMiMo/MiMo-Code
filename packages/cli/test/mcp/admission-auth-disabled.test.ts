// [TP-MCU-R7-21][TP-MCU-R10-20] Host admission: authenticate must not open a host-disabled server.
import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { MCP } from "../../src/mcp"
import { HostMcp } from "../../src/mcp/host"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(MCP.defaultLayer, McpAuth.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.live("[TP-MCU-R7-21][TP-MCU-R10-20] authenticate must not open a host-disabled server", () =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        HostMcp.set({})
        await McpOAuthCallback.stop()
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
            const result =
              msg.method === "initialize"
                ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test-server", version: "1" } }
                : { tools: [{ name: "read", inputSchema: { type: "object" } }] }
            return Response.json({ jsonrpc: "2.0", id: msg.id, result })
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    HostMcp.set({ example: { type: "remote", url: `${server.url}mcp`, enabled: false } })
    yield* provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect(Object.keys(yield* mcp.tools())).toEqual([])
        const result = yield* Effect.exit(mcp.authenticate("example"))
        expect(Exit.isFailure(result)).toBe(true)
        expect(Object.keys(yield* mcp.tools())).toEqual([])
        const clients = yield* mcp.clients()
        expect(clients.example).toBeUndefined()
      }),
    )
  }),
)
