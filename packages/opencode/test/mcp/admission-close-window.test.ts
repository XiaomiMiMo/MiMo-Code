// [TP-MCU-R7-21][TP-MCU-R10-20] R002: commit-first storeClient — hanging previous.close must not dead-register or close successor.
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { MCP } from "../../src/mcp"
import { HostMcp } from "../../src/mcp/host"
import { McpAuth } from "../../src/mcp/auth"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(MCP.defaultLayer, McpAuth.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.live("[TP-MCU-R7-21][TP-MCU-R10-20] hanging previous.close during host switch keeps successor live", () =>
  Effect.gen(function* () {
    let releaseClose!: () => void
    let enteredClose!: () => void
    const closeBlocked = new Promise<void>((r) => (releaseClose = r))
    const closeStarted = new Promise<void>((r) => (enteredClose = r))
    let oldToolsLists = 0
    let newToolsLists = 0
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        releaseClose()
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
            if (msg.method === "tools/list") {
              if (name === "old") oldToolsLists += 1
              else newToolsLists += 1
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
        const previous = (yield* mcp.clients()).example!
        expect(previous).toBeTruthy()
        expect(oldToolsLists).toBeGreaterThan(0)

        const originalClose = previous.close.bind(previous)
        let closeCalls = 0
        ;(previous as { close: () => Promise<void> }).close = () => {
          closeCalls += 1
          enteredClose()
          return closeBlocked.then(() => originalClose())
        }

        HostMcp.set({ example: cfg("new") })
        // connect() uses storeClient commit-first and does not hold the refresh permit.
        const switchFiber = yield* mcp.connect("example").pipe(Effect.forkChild)
        yield* Effect.promise(() => closeStarted)

        // Successor finished create() (tools/list on /new) while previous.close hangs.
        expect(newToolsLists).toBeGreaterThan(0)
        expect(closeCalls).toBe(1)

        releaseClose()
        yield* Fiber.join(switchFiber)

        const successor = (yield* mcp.clients()).example!
        expect(successor).toBeTruthy()
        expect(successor).not.toBe(previous)
        expect(successor.transport).toBeDefined()
        expect(Object.keys(yield* mcp.tools())).toEqual(["example_new"])
        expect((yield* mcp.status()).example?.status).toBe("connected")
        expect(previous.transport).toBeUndefined()
      }),
    )
  }),
)
