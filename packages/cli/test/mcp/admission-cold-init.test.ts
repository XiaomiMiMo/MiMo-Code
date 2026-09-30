// [TP-MCU-R7-21][TP-MCU-R10-20] R006: cold InstanceState initialize barrier — switch host mid-initialize keeps B live.
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { MCP } from "../../src/mcp"
import { HostMcp } from "../../src/mcp/host"
import { McpAuth } from "../../src/mcp/auth"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(MCP.defaultLayer, McpAuth.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.live("[TP-MCU-R7-21][TP-MCU-R10-20] cold-init host switch during A initialize keeps B client live", () =>
  Effect.gen(function* () {
    let releaseInit!: () => void
    let enteredInit!: () => void
    const initBlocked = new Promise<void>((r) => (releaseInit = r))
    const initStarted = new Promise<void>((r) => (enteredInit = r))
    let oldInits = 0
    let newInits = 0
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        releaseInit()
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
            if (msg.method === "initialize") {
              if (name === "old") {
                oldInits += 1
                if (oldInits === 1) {
                  enteredInit()
                  await initBlocked
                }
              } else {
                newInits += 1
              }
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
    // Snapshot identity is bound with the config object at init start. A host
    // switch during A's initialize must reject A (stale revision) and leave B
    // as the only live client (R009/R013).
    HostMcp.set({ example: cfg("old") })
    yield* provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const cold = yield* mcp.tools().pipe(Effect.forkChild)
        yield* Effect.promise(() => initStarted)
        HostMcp.set({ example: cfg("new") })
        releaseInit()
        yield* Fiber.join(cold)

        expect(Object.keys(yield* mcp.tools())).toEqual(["example_new"])
        expect(newInits).toBeGreaterThan(0)
        const client = (yield* mcp.clients()).example!
        expect(client).toBeTruthy()
        expect(client.transport).toBeDefined()
        // status/connected must be backed by a live client (R013).
        expect((yield* mcp.status()).example?.status).toBe("connected")
        const tool = (yield* mcp.tools()).example_new
        expect(tool).toBeDefined()
      }),
    )
  }),
)
