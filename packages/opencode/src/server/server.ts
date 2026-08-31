import { generateSpecs } from "hono-openapi"
import { Hono } from "hono"
import { adapter } from "#hono"
import { lazy } from "@/util/lazy"
import { Log } from "@/util"
import { Flag } from "@/flag/flag"
import { WorkspaceID } from "@/control-plane/schema"
import { MDNS } from "./mdns"
import { AuthMiddleware, CompressionMiddleware, CorsMiddleware, ErrorMiddleware, LoggerMiddleware } from "./middleware"
import { FenceMiddleware } from "./fence"
import { initProjectors } from "./projectors"
import { InstanceRoutes } from "./routes/instance"
import { ControlPlaneRoutes } from "./routes/control"
import { UIRoutes } from "./routes/ui"
import { GlobalRoutes } from "./routes/global"
import { WorkspaceRouterMiddleware } from "./workspace"
import { InstanceMiddleware } from "./routes/instance/middleware"
import { WorkspaceRoutes } from "./routes/control/workspace"
import { setChildProcessEnv } from "@/util/child-process-env"
import { LLMServerTokens } from "@/llm-server/tokens"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

initProjectors()

const log = Log.create({ service: "server" })

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
}

export const Default = lazy(() => create({}))

function create(opts: { cors?: string[] }) {
  const app = new Hono()
    .onError(ErrorMiddleware)
    .use(CorsMiddleware(opts))
    .use(LoggerMiddleware)
    .use(AuthMiddleware)
    .use(CompressionMiddleware)
    .route("/global", GlobalRoutes())

  const runtime = adapter.create(app)

  if (Flag.MIMOCODE_WORKSPACE_ID) {
    return {
      app: app
        .use(InstanceMiddleware(Flag.MIMOCODE_WORKSPACE_ID ? WorkspaceID.make(Flag.MIMOCODE_WORKSPACE_ID) : undefined))
        .use(FenceMiddleware)
        .route("/", InstanceRoutes(runtime.upgradeWebSocket)),
      runtime,
    }
  }

  return {
    app: app
      .route("/", ControlPlaneRoutes())
      .route(
        "/",
        new Hono()
          .use(InstanceMiddleware())
          .route("/experimental/workspace", WorkspaceRoutes())
          .use(WorkspaceRouterMiddleware(runtime.upgradeWebSocket))
          .route("/", InstanceRoutes(runtime.upgradeWebSocket)),
      )
      .route("/", UIRoutes()),
    runtime,
  }
}

export async function openapi() {
  // Build a fresh app with all routes registered directly so
  // hono-openapi can see describeRoute metadata (`.route()` wraps
  // handlers when the sub-app has a custom errorHandler, which
  // strips the metadata symbol).
  const { app } = create({})
  const result = await generateSpecs(app, {
    documentation: {
      info: {
        title: "opencode",
        version: "1.0.0",
        description: "opencode api",
      },
      openapi: "3.1.1",
    },
  })
  return result
}

export let url: URL

export async function listen(opts: {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
  cors?: string[]
  noAuth?: boolean
  childEnv?: NodeJS.ProcessEnv
  /**
   * Advertise this listener in the llm-server address registry so
   * `mimo llm-server issue` can resolve `base_url`. Defaults to true.
   * Embedders that only need an in-process app can pass false.
   */
  advertise?: boolean
}): Promise<Listener> {
  if (opts.childEnv) setChildProcessEnv(opts.childEnv)
  const isLoopback =
    opts.hostname === "127.0.0.1" || opts.hostname === "localhost" || opts.hostname === "::1"
  if (!isLoopback && !Flag.MIMOCODE_SERVER_PASSWORD && !opts.noAuth) {
    throw new Error(
      "Refusing to bind to non-loopback address without MIMOCODE_SERVER_PASSWORD. " +
        "Set the environment variable or pass noAuth to explicitly allow unauthenticated access.",
    )
  }

  const built = create(opts)
  const server = await built.runtime.listen(opts)

  const next = new URL("http://localhost")
  next.hostname = opts.hostname
  next.port = String(server.port)
  url = next

  const mdns =
    opts.mdns &&
    server.port &&
    opts.hostname !== "127.0.0.1" &&
    opts.hostname !== "localhost" &&
    opts.hostname !== "::1"
  if (mdns) {
    MDNS.publish(server.port, opts.mdnsDomain)
  } else if (opts.mdns) {
    log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
  }

  // Who owns the `/v1` capability surface must also say where it is. Keyed by cwd —
  // TUI/serve chdir to the project; Desktop hosts many projects from one listener and
  // `discoverAddress` falls back to any live host when the project bucket is empty.
  const advertise = opts.advertise !== false
  const directory = process.cwd()
  if (advertise) {
    await LLMServerTokens.publish(directory, {
      pid: process.pid,
      hostname: opts.hostname,
      port: server.port,
      url: next.toString(),
      started: Date.now(),
    }).catch((error) => log.warn("failed to advertise llm-server address", { error: String(error) }))
  }

  let closing: Promise<void> | undefined
  return {
    hostname: opts.hostname,
    port: server.port,
    url: next,
    stop(close?: boolean) {
      closing ??= (async () => {
        // Withdraw the advertisement before the socket goes away, so a reader sees
        // "nothing is serving" rather than a port that refuses connections. A crash
        // skips this; the pid liveness check in `addresses` is the backstop.
        if (advertise) await LLMServerTokens.unpublish(directory).catch(() => {})
        if (mdns) MDNS.unpublish()
        await server.stop(close)
      })()
      return closing
    },
  }
}

export * as Server from "./server"
