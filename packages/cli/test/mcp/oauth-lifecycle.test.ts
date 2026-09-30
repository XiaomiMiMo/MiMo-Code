import { expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { MCP } from "../../src/mcp"
import { McpAuth } from "../../src/mcp/auth"
import { ManagedClient } from "../../src/mcp/managed-client"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(MCP.defaultLayer, McpAuth.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.live("startAuth closes no-redirect probes without replacing the active MCP connection", () =>
  Effect.gen(function* () {
    const clients: ManagedClient[] = []
    const original = ManagedClient.prototype.connect
    // Observe ownership while keeping the real SDK and HTTP transport in use.
    const connect = spyOn(ManagedClient.prototype, "connect").mockImplementation(function (
      this: ManagedClient,
      ...args
    ) {
      clients.push(this)
      return original.apply(this, args)
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        connect.mockRestore()
        await Promise.all(clients.map((client) => client.close()))
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
            const message = await request.json()
            if (message.id == null) return new Response(null, { status: 202 })
            const result =
              message.method === "initialize"
                ? {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: { name: "test-server", version: "1" },
                  }
                : { tools: [] }
            return Response.json({ jsonrpc: "2.0", id: message.id, result })
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )

    yield* provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Bun.write(
            `${dir}/mimocode.json`,
            JSON.stringify({ mcp: { example: { type: "remote", url: `${server.url}mcp` } } }),
          ),
        )
        const mcp = yield* MCP.Service
        const auth = yield* McpAuth.Service
        const active = (yield* mcp.clients()).example!
        expect(active.transport).toBeDefined()

        for (let i = 0; i < 2; i++) {
          const result = yield* mcp.startAuth("example")
          expect(result).toEqual({ authorizationUrl: "", oauthState: expect.any(String) })
          expect(clients).toHaveLength(i + 2)
          expect(clients.at(-1)!.transport).toBeUndefined()
          expect(yield* auth.getOAuthState("example")).toBeUndefined()
          expect((yield* mcp.clients()).example).toBe(active)
          expect(active.transport).toBeDefined()
        }

        yield* mcp.disconnect("example")
        expect(active.transport).toBeUndefined()
      }),
    )
    expect(clients.every((client) => client.transport == null)).toBe(true)
  }),
)
