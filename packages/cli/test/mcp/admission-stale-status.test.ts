// [TP-MCU-R7-21][TP-MCU-R10-20] R008: reject-stale with empty status must not fabricate "connected".
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { MCP } from "../../src/mcp"
import { HostMcp } from "../../src/mcp/host"
import { McpAuth } from "../../src/mcp/auth"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(MCP.defaultLayer, McpAuth.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.live("[TP-MCU-R7-21][TP-MCU-R10-20] stale create discarded against empty status is not reported connected", () =>
  Effect.gen(function* () {
    let releaseLists!: () => void
    let enteredLists!: () => void
    const listsBlocked = new Promise<void>((r) => (releaseLists = r))
    const listsStarted = new Promise<void>((r) => (enteredLists = r))
    let oldLists = 0
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        releaseLists()
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
            if (msg.method === "tools/list" && name === "old" && ++oldLists === 1) {
              enteredLists()
              await listsBlocked
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
        HostMcp.set({})
        yield* mcp.tools()

        HostMcp.set({ example: cfg("old") })
        const pending = yield* mcp.connect("example").pipe(Effect.forkChild)
        yield* Effect.promise(() => listsStarted)

        // Host generation moves on while A still has an unpublished client.
        // Do not publish B yet so s.status[name] stays empty for reject-stale.
        HostMcp.set({ example: cfg("new") })
        releaseLists()
        yield* Fiber.join(pending)

        // Stale A must be discarded; without a live status entry the API must
        // not fabricate "connected" (R008). refreshHost then installs B.
        expect(Object.keys(yield* mcp.tools())).toEqual(["example_new"])
        expect((yield* mcp.status()).example?.status).toBe("connected")
        expect((yield* mcp.clients()).example).toBeTruthy()
        expect((yield* mcp.clients()).example!.transport).toBeDefined()
      }),
    )
  }),
)
