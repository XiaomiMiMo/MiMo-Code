// [TP-MCU-R7-21][TP-MCU-R10-20] R007: pending OAuth publish is generation-aware, not first-wins.
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp"
import { HostMcp } from "../../src/mcp/host"
import { McpAuth } from "../../src/mcp/auth"

const it = testEffect(Layer.mergeAll(MCP.defaultLayer, McpAuth.defaultLayer, CrossSpawnSpawner.defaultLayer))

type OAuthServer = {
  url: string
  tokenPosts: number
  stop: () => Promise<void>
}

function serveOAuthServer(opts?: {
  blockAuthServerMetadataUntil?: { entered: () => void; blocked: Promise<void> }
}): OAuthServer {
  const counters = { tokenPosts: 0 }
  let base = ""
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === "/mcp") {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          },
        })
      }
      if (path === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: `${base}/mcp`,
          authorization_servers: [base],
        })
      }
      if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
        // Hold late A in discovery so B can publish pending first (no DCR overwrite).
        if (opts?.blockAuthServerMetadataUntil) {
          opts.blockAuthServerMetadataUntil.entered()
          await opts.blockAuthServerMetadataUntil.blocked
        }
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      }
      if (path === "/register" && request.method === "POST") {
        return Response.json({
          client_id: "test-client",
          client_id_issued_at: 1,
          redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        })
      }
      if (path === "/token" && request.method === "POST") {
        counters.tokenPosts += 1
        return Response.json({
          access_token: "test-token",
          token_type: "Bearer",
          expires_in: 3600,
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
  return {
    get url() {
      return base
    },
    get tokenPosts() {
      return counters.tokenPosts
    },
    stop: () => server.stop(true),
  }
}

const hostCfg = (url: string) => ({
  type: "remote" as const,
  url,
  // Pre-registered client skips DCR so a late attempt cannot clobber B's client info.
  oauth: { clientId: "test-client" } as const,
  enabled: true,
})

it.live("[TP-MCU-R7-21][TP-MCU-R10-20] current host B replaces stale pending A", () =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => HostMcp.set({})))
    const oldSrv = yield* Effect.acquireRelease(
      Effect.sync(() => serveOAuthServer()),
      (s) => Effect.promise(() => s.stop()),
    )
    const newSrv = yield* Effect.acquireRelease(
      Effect.sync(() => serveOAuthServer()),
      (s) => Effect.promise(() => s.stop()),
    )
    yield* provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        HostMcp.set({})
        yield* mcp.tools()

        HostMcp.set({ example: hostCfg(`${oldSrv.url}/mcp`) })
        yield* mcp.connect("example")
        expect((yield* mcp.status()).example?.status).toBe("needs_auth")

        HostMcp.set({ example: hostCfg(`${newSrv.url}/mcp`) })
        yield* mcp.connect("example")
        expect((yield* mcp.status()).example?.status).toBe("needs_auth")

        const result = yield* mcp.finishAuth("example", "code").pipe(
          Effect.catch((e) => Effect.succeed({ status: "failed" as const, error: String(e) })),
        )
        expect(newSrv.tokenPosts).toBe(1)
        expect(oldSrv.tokenPosts).toBe(0)
        expect(result.status).not.toBe("failed")
      }),
    )
  }),
)

it.live("[TP-MCU-R7-21][TP-MCU-R10-20] late stale A Unauthorized does not overwrite current B pending", () =>
  Effect.gen(function* () {
    let releaseA!: () => void
    let enteredA!: () => void
    const blocked = new Promise<void>((r) => (releaseA = r))
    const started = new Promise<void>((r) => (enteredA = r))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        releaseA()
        HostMcp.set({})
      }),
    )
    const oldSrv = yield* Effect.acquireRelease(
      Effect.sync(() => serveOAuthServer({ blockAuthServerMetadataUntil: { entered: enteredA, blocked } })),
      (s) => Effect.promise(() => s.stop()),
    )
    const newSrv = yield* Effect.acquireRelease(
      Effect.sync(() => serveOAuthServer()),
      (s) => Effect.promise(() => s.stop()),
    )
    yield* provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        HostMcp.set({})
        yield* mcp.tools()

        HostMcp.set({ example: hostCfg(`${oldSrv.url}/mcp`) })
        const pendingA = yield* mcp.connect("example").pipe(Effect.forkChild)
        yield* Effect.promise(() => started)

        HostMcp.set({ example: hostCfg(`${newSrv.url}/mcp`) })
        yield* mcp.connect("example")
        expect((yield* mcp.status()).example?.status).toBe("needs_auth")

        releaseA()
        yield* Fiber.join(pendingA)

        const result = yield* mcp.finishAuth("example", "code").pipe(
          Effect.catch((e) => Effect.succeed({ status: "failed" as const, error: String(e) })),
        )
        expect(newSrv.tokenPosts).toBe(1)
        expect(oldSrv.tokenPosts).toBe(0)
        expect(result.status).not.toBe("failed")
      }),
    )
  }),
)

it.live("[TP-MCU-R7-21][TP-MCU-R10-20] empty map: stale late A Unauthorized does not register", () =>
  Effect.gen(function* () {
    let releaseA!: () => void
    let enteredA!: () => void
    const blocked = new Promise<void>((r) => (releaseA = r))
    const started = new Promise<void>((r) => (enteredA = r))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        releaseA()
        HostMcp.set({})
      }),
    )
    const oldSrv = yield* Effect.acquireRelease(
      Effect.sync(() => serveOAuthServer({ blockAuthServerMetadataUntil: { entered: enteredA, blocked } })),
      (s) => Effect.promise(() => s.stop()),
    )
    const newSrv = yield* Effect.acquireRelease(
      Effect.sync(() => serveOAuthServer()),
      (s) => Effect.promise(() => s.stop()),
    )
    yield* provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        HostMcp.set({})
        yield* mcp.tools()

        HostMcp.set({ example: hostCfg(`${oldSrv.url}/mcp`) })
        const pendingA = yield* mcp.connect("example").pipe(Effect.forkChild)
        yield* Effect.promise(() => started)

        HostMcp.set({ example: hostCfg(`${newSrv.url}/mcp`) })
        yield* mcp.removeAuth("example")

        releaseA()
        yield* Fiber.join(pendingA)

        const finish = yield* mcp.finishAuth("example", "code").pipe(Effect.exit)
        expect(finish._tag).toBe("Failure")
        expect(oldSrv.tokenPosts).toBe(0)
        expect(newSrv.tokenPosts).toBe(0)
      }),
    )
  }),
)
