import { toolPresentationProgress } from "./tool-progress"
import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { childProcessEnv } from "@/util/child-process-env"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config"
import { ConfigMCP } from "../config/mcp"
import { Log } from "../util"
import { NamedError } from "@mimo-ai/shared/util/error"
import z from "zod/v4"
import { Installation } from "../installation"
import { InstallationVersion } from "../installation/version"
import { withTimeout } from "@/util/timeout"
import { ObservingStdioTransport } from "./stdio-transport"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { McpOAuthProvider } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"
import { Deferred, Effect, Exit, Layer, Option, Context, Scope, Stream, Semaphore } from "effect"
import { HostMcp } from "./host"
import { ManagedClient } from "./managed-client"
import { EffectBridge } from "@/effect"
import { InstanceState } from "@/effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { McpSampling } from "./sampling"
import { McpElicitation } from "./elicitation"
import { SessionID } from "@/session/schema"

const log = Log.create({ service: "mcp" })
const DEFAULT_TIMEOUT = 30_000
/** How long `MCP.tools()` waits for startup connections before returning what is ready. */
const FIRST_TURN_WAIT = 3_000
/** How long `MCP.tools()` waits for the dormant-server restarts it started; they keep running past it. */
const REVIVE_WAIT = 15_000
/** Delay before a dormant server that failed to restart is tried again; doubles per failure up to the cap. */
const REVIVE_BACKOFF = 5_000
const REVIVE_BACKOFF_MAX = 5 * 60_000

/**
 * Host entries fully replace the user record for that name. When the host omits
 * sampling, default to ask rather than silently inheriting the covered user field.
 * Exported for unit tests that pin the same-snapshot ownership binding.
 */
export function hostEffectiveSampling(mcp: ConfigMCP.Info | undefined, hostOwned: boolean) {
  if (!mcp) return undefined
  if (hostOwned) return mcp.sampling ?? ("ask" as const)
  return mcp.sampling
}

export const Resource = z
  .object({
    name: z.string(),
    uri: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    client: z.string(),
  })
  .meta({ ref: "McpResource" })
export type Resource = z.infer<typeof Resource>

export const ToolsChanged = BusEvent.define(
  "mcp.tools.changed",
  z.object({
    server: z.string(),
  }),
)

export const BrowserOpenFailed = BusEvent.define(
  "mcp.browser.open.failed",
  z.object({
    mcpName: z.string(),
    url: z.string(),
  }),
)

export const Failed = NamedError.create(
  "MCPFailed",
  z.object({
    name: z.string(),
  }),
)

type MCPClient = ManagedClient

export const TURN_LIFECYCLE_CAPABILITY = "com.xiaomi.mimo/turn-lifecycle"
export const TURN_LIFECYCLE_NOTIFICATION = `notifications/${TURN_LIFECYCLE_CAPABILITY}`
export const TURN_LIFECYCLE_VERSION = 1
export const TURN_LIFECYCLE_NOTIFICATION_TIMEOUT = 1_000
// A send that has already outlived the per-turn budget can never be useful to wait
// on again, so later turns abandon it instead of queueing behind it forever.
export const TURN_LIFECYCLE_STUCK_TIMEOUT = TURN_LIFECYCLE_NOTIFICATION_TIMEOUT

/**
 * Capabilities MiMoCode declares in `initialize`. Exported so tests assert on the
 * SAME object the client is constructed with rather than a copy that could drift.
 */
export const CLIENT_OPTIONS = {
  capabilities: {
    // Declared because we register a `sampling/createMessage` request handler
    // below; the SDK's assertRequestHandlerCapability refuses the registration
    // without it. Intentionally an empty object: `sampling.tools` and
    // `sampling.context` are NOT implemented, and declaring them would invite
    // servers to send `tools`/`includeContext` payloads we would have to reject.
    sampling: {},
    elicitation: { form: {} },
    experimental: {
      [TURN_LIFECYCLE_CAPABILITY]: { version: TURN_LIFECYCLE_VERSION },
    },
  },
}

interface PendingTurnLifecycleNotification {
  readonly promise: Promise<void>
  readonly waiters: Set<() => void>
  readonly startedAt: number
}

const pendingTurnLifecycleNotifications = new WeakMap<Client, PendingTurnLifecycleNotification>()

export interface TurnContext {
  [key: string]: unknown
  sessionId: string
  turnId: string
  actorId?: string
}

// The same context object is used throughout a runLoop and its finalizer.
// Keep every generation used by that turn, including between model/tool calls.
const turnClients = new WeakMap<TurnContext, Map<MCPClient, { name: string; release: () => void }>>()

export type TurnStatus = "completed" | "cancelled" | "error"

function supportsTurnLifecycle(client: Client) {
  const capability = client.getServerCapabilities()?.experimental?.[TURN_LIFECYCLE_CAPABILITY]
  return (
    typeof capability === "object" &&
    capability !== null &&
    "version" in capability &&
    capability.version === TURN_LIFECYCLE_VERSION
  )
}

function startTurnLifecycleNotification(client: Client, context: TurnContext, status: TurnStatus) {
  if (pendingTurnLifecycleNotifications.has(client)) return undefined
  const promise = Promise.resolve().then(() =>
    client.notification({
      method: TURN_LIFECYCLE_NOTIFICATION,
      params: { ...context, status },
    } as Parameters<Client["notification"]>[0]),
  )
  const notification: PendingTurnLifecycleNotification = { promise, waiters: new Set(), startedAt: Date.now() }
  pendingTurnLifecycleNotifications.set(client, notification)
  const clear = () => {
    if (pendingTurnLifecycleNotifications.get(client) === notification) {
      pendingTurnLifecycleNotifications.delete(client)
    }
    const waiters = [...notification.waiters]
    notification.waiters.clear()
    for (const waiter of waiters) waiter()
  }
  // Attached at creation so an orphaned send's eventual rejection is always swallowed.
  void promise.then(clear, clear)
  return notification
}

// A send that outlives the per-turn budget is treated as stuck: drop it from the
// pending map so the next turn sends immediately instead of paying the timeout
// forever. The orphaned promise is never awaited again; its settlement still runs
// `clear`, which no-ops because the map entry has been replaced.
function releaseStuckTurnLifecycleNotification(
  client: Client,
  notification: PendingTurnLifecycleNotification,
  clientName: string,
) {
  if (pendingTurnLifecycleNotifications.get(client) !== notification) return
  pendingTurnLifecycleNotifications.delete(client)
  log.warn("abandoning stuck MCP turn lifecycle notification", {
    clientName,
    elapsed: Date.now() - notification.startedAt,
  })
  const waiters = [...notification.waiters]
  notification.waiters.clear()
  for (const waiter of waiters) waiter()
}

function waitForTurnLifecycleNotification(client: Client, notification: PendingTurnLifecycleNotification) {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        let done = false
        const cleanup = () => {
          notification.waiters.delete(onSettled)
          signal.removeEventListener("abort", onAbort)
        }
        const finish = (complete: () => void) => {
          if (done) return
          done = true
          cleanup()
          complete()
        }
        const onSettled = () => finish(resolve)
        const onAbort = () =>
          finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error("Lifecycle wait aborted")))

        notification.waiters.add(onSettled)
        signal.addEventListener("abort", onAbort, { once: true })

        if (signal.aborted) onAbort()
        else if (pendingTurnLifecycleNotifications.get(client) !== notification) onSettled()
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function sendTurnLifecycleNotification(client: Client, context: TurnContext, status: TurnStatus, clientName: string) {
  return Effect.gen(function* () {
    while (true) {
      const pending = pendingTurnLifecycleNotifications.get(client)
      if (pending) {
        if (Date.now() - pending.startedAt >= TURN_LIFECYCLE_STUCK_TIMEOUT) {
          releaseStuckTurnLifecycleNotification(client, pending, clientName)
          continue
        }
        yield* waitForTurnLifecycleNotification(client, pending)
        continue
      }

      const notification = startTurnLifecycleNotification(client, context, status)
      if (!notification) continue
      return yield* Effect.tryPromise({
        try: () => notification.promise,
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
    }
  })
}

export function notifyTurnLifecycle(clients: Record<string, Client>, context: TurnContext, status: TurnStatus) {
  const retained = turnClients.get(context)
  return Effect.forEach(
    retained ? [...retained].map(([client, entry]) => [entry.name, client] as const) : Object.entries(clients),
    ([clientName, client]) => {
      if (!supportsTurnLifecycle(client)) return Effect.void
      return sendTurnLifecycleNotification(client, context, status, clientName).pipe(
        Effect.timeout(TURN_LIFECYCLE_NOTIFICATION_TIMEOUT),
        Effect.tapError((error) =>
          Effect.sync(() => log.warn("failed to notify MCP turn lifecycle", { clientName, status, error })),
        ),
        Effect.ignore,
      )
    },
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.ensuring(releaseTurnClients(context)))
}

function retainForTurn(context: TurnContext, name: string, client: MCPClient) {
  const retained = turnClients.get(context) ?? new Map<MCPClient, { name: string; release: () => void }>()
  if (!retained.has(client)) retained.set(client, { name, release: client.retain() })
  turnClients.set(context, retained)
}

/** Also used by the outer run finalizer if post-session bookkeeping fails. */
export function releaseTurnClients(context: TurnContext) {
  return Effect.sync(() => {
    const retained = turnClients.get(context)
    turnClients.delete(context)
    for (const entry of retained?.values() ?? []) entry.release()
  })
}

export const Status = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("connected"),
      })
      .meta({
        ref: "MCPStatusConnected",
      }),
    z
      .object({
        status: z.literal("disabled"),
      })
      .meta({
        ref: "MCPStatusDisabled",
      }),
    z
      .object({
        status: z.literal("pending"),
      })
      .meta({
        ref: "MCPStatusPending",
      }),
    z
      .object({
        status: z.literal("failed"),
        error: z.string(),
      })
      .meta({
        ref: "MCPStatusFailed",
      }),
    z
      .object({
        status: z.literal("needs_auth"),
      })
      .meta({
        ref: "MCPStatusNeedsAuth",
      }),
    z
      .object({
        status: z.literal("needs_client_registration"),
        error: z.string(),
      })
      .meta({
        ref: "MCPStatusNeedsClientRegistration",
      }),
  ])
  .meta({
    ref: "MCPStatus",
  })
export type Status = z.infer<typeof Status>

// Store transports for OAuth servers to allow finishing auth.
// Transport + host revision form one pending-attempt record (R007).
type PendingOAuthAttempt = {
  transport: TransportWithAuth
  hostRevision?: string
  fromHost: boolean
}
const pendingOAuthTransports = new Map<string, PendingOAuthAttempt>()

/**
 * Publish a pending OAuth attempt only when it still matches the live host
 * generation. A current host attempt always replaces a stale one; a stale late
 * Unauthorized never registers over (or into) a slot reserved for the live host.
 */
function publishPendingOAuthAttempt(
  key: string,
  attempt: PendingOAuthAttempt,
): void {
  const currentRev = HostMcp.revisionOf(key)
  if (attempt.fromHost && attempt.hostRevision != null) {
    if (attempt.hostRevision !== currentRev) return
    pendingOAuthTransports.set(key, attempt)
    return
  }
  const existing = pendingOAuthTransports.get(key)
  const existingIsCurrentHost =
    !!existing?.fromHost && existing.hostRevision != null && existing.hostRevision === currentRev
  if (!existingIsCurrentHost) pendingOAuthTransports.set(key, attempt)
}

type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type McpEntry = NonNullable<Config.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCP.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

/**
 * Convert an MCP tool definition to an AI SDK tool. `source` is a thunk for a dormant
 * server: the call restarts it first, the schema stays as published.
 */
export function convertMcpTool(
  mcpTool: MCPToolDef,
  source: MCPClient | (() => Promise<MCPClient>),
  timeout?: number,
  context?: TurnContext,
): Tool {
  const inputSchema = mcpTool.inputSchema

  // Spread first, then override type to ensure it's always "object"
  const schema: JSONSchema7 = {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown, options) => {
      const client = typeof source === "function" ? await source() : source
      const metadata =
        context && supportsTurnLifecycle(client) ? { _meta: { [TURN_LIFECYCLE_CAPABILITY]: context } } : {}
      // Recorded before the call so a `sampling/createMessage` arriving WHILE
      // this call is in flight can address its approval prompt at this session.
      if (context) McpSampling.setActiveSession(client, SessionID.make(context.sessionId))
      const progress = toolPresentationProgress(options.experimental_context)
      const finish = McpElicitation.beginCall(client, context?.sessionId, options.abortSignal)
      try {
        return await client.callTool(
          {
            name: mcpTool.name,
            arguments: (args || {}) as Record<string, unknown>,
            ...metadata,
          },
          CallToolResultSchema,
          {
            resetTimeoutOnProgress: true,
            onprogress: progress.update,
            signal: options.abortSignal,
            timeout,
          },
        )
      } finally {
        finish()
        await progress.drain()
      }
    },
  })
}

function defs(key: string, client: MCPClient, timeout?: number) {
  return Effect.tryPromise({
    try: () => withTimeout(client.listTools(), timeout ?? DEFAULT_TIMEOUT),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return Effect.succeed(undefined)
    }),
  )
}

function fetchFromClient<T extends { name: string }>(
  clientName: string,
  client: Client,
  listFn: (c: Client) => Promise<T[]>,
  label: string,
) {
  return Effect.tryPromise({
    try: () => listFn(client),
    catch: (e: any) => {
      log.error(`failed to get ${label}`, { clientName, error: e.message })
      return e
    },
  }).pipe(
    Effect.map((items) => {
      const out: Record<string, T & { client: string }> = {}
      const sanitizedClient = sanitize(clientName)
      for (const item of items) {
        out[sanitizedClient + ":" + sanitize(item.name)] = { ...item, client: clientName }
      }
      return out
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
  launch?: Launch
}

/** What a server was started with: its config, the full environment of a local process, and who owns it. */
interface Launch {
  mcp: ConfigMCP.Info
  env?: Record<string, string>
  fromHost: boolean
}

type AuthResult =
  | {
      kind: "connected"
      oauthState: string
      client: MCPClient
      /** Config snapshot that opened this connection; sampling must stay bound to it. */
      resolved: { mcp: ConfigMCP.Info; hostOwned: boolean }
      hostRevision?: string
    }
  | { kind: "redirect"; authorizationUrl: string; oauthState: string }

// --- Effect Service ---

interface State {
  host: Record<string, string>
  hostRetryAt: Record<string, number>
  retired: Set<MCPClient>
  refresh: Semaphore.Semaphore
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
  /**
   * What each live server was started with. A dormant server restarts from this, so its
   * command and environment are identical to the first connection.
   */
  launch: Record<string, Launch>
  /** Restart bookkeeping of a dormant server: the attempt in flight, and the backoff after a failure. */
  revival: Record<string, { attempt?: Deferred.Deferred<void>; retryAt: number; failures: number; error?: string }>
  scope: Scope.Scope
  /** Completes once every startup connection attempt has finished (success or not). */
  settled: Deferred.Deferred<void>
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: (context?: TurnContext) => Effect.Effect<Record<string, MCPClient>>
  readonly tools: (context?: TurnContext) => Effect.Effect<Record<string, Tool>>
  /** Optional non-blocking connect snapshot for reminders/search diagnostics. Never awaits `settled`. */
  readonly readiness?: () => Effect.Effect<{
    configured: boolean
    servers: Array<{
      name: string
      status: Status["status"]
      toolCount?: number
      error?: string
      tools?: Array<{ name: string; description: string }>
    }>
  }>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCP.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void>
  readonly disconnect: (name: string) => Effect.Effect<void>
  /** Release a server's process but keep its tools listed; it restarts on next use. */
  readonly suspend: (name: string) => Effect.Effect<void>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (mcpName: string) => Effect.Effect<{ authorizationUrl: string; oauthState: string }>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const bus = yield* Bus.Service
    const createClient = () => new ManagedClient({ name: "mimocode", version: InstallationVersion }, CLIENT_OPTIONS)

    type Transport = ObservingStdioTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = (transport: Transport, timeout: number) =>
      Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = createClient()
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "remote" },
      identity?: { hostRevision?: string; fromHost: boolean },
    ) {
      // Prefer the caller's creation snapshot; only fall back to current HostMcp
      // when create() was invoked without one (e.g. refreshHost discovery).
      const hostRevisionAtCreate =
        identity?.hostRevision ?? (HostMcp.get()[key] ? HostMcp.revisionOf(key) : undefined)
      const fromHostAtCreate = identity?.fromHost ?? hostRevisionAtCreate != null
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
            },
          },
          auth,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              log.info("mcp server requires authentication", { key, transport: name })

              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                // Generation-aware publish (R007): current host attempts replace
                // stale pending; stale late Unauthorized cannot register.
                publishPendingOAuthAttempt(key, {
                  transport,
                  hostRevision: hostRevisionAtCreate,
                  fromHost: fromHostAtCreate,
                })
                lastStatus = { status: "needs_auth" as const }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: mimo mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            log.debug("transport connection failed", {
              key,
              transport: name,
              url: ConfigMCP.redactString(mcp.url),
              error: lastError.message,
            })
            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.succeed(undefined)
          }),
        )
        if (result) {
          log.info("connected", { key, transport: result.transportName })
          return { client: result.client as MCPClient | undefined, status: { status: "connected" } as Status }
        }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "local" },
      launchEnv?: Record<string, string>,
    ) {
      const [cmd, ...args] = mcp.command
      const env = launchEnv ?? {
        ...childProcessEnv(),
        ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
        ...mcp.environment,
      }
      const cwd = yield* InstanceState.directory
      // Own the child through the public child_process API. SDK StdioClientTransport
      // clears its private `_process` in close() before callers can read exitCode, and
      // onclose does not receive the code — so the failure snapshot must be captured here.
      const transport = new ObservingStdioTransport({
        command: cmd,
        args,
        cwd,
        // childProcessEnv: MCP servers are third-party binaries running as the user.
        // Note for `opencode` configured as its own MCP server: that nested engine no longer
        // inherits the host's credentials or config content, and falls back to reading auth.json
        // and the config file from disk — which is what a plain CLI invocation does anyway.
        env,
      })
      transport.onerror = (error) => {
        log.info(`mcp transport error: ${error.message}`, { key })
      }
      transport.onStderr = (text) => {
        log.info(`mcp stderr: ${text}`, { key })
      }

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status; env?: typeof env } => ({
          client,
          status: { status: "connected" },
          env,
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status; env?: typeof env }> => {
          const msg = error instanceof Error ? error.message : String(error)
          const exit = transport.exitSnapshot()
          const stderrTail = transport.stderrSnapshot().trim()
          // hostShutdown means close() tore the child down; that signal is our cleanup,
          // not the child's startup-failure cause.
          const natural = exit && !exit.hostShutdown ? exit : undefined
          log.error("local mcp startup failed", {
            key,
            command: ConfigMCP.redactCommand(mcp.command),
            cwd,
            error: msg,
            pid: exit?.pid ?? null,
            exitCode: natural?.exitCode ?? null,
            signalCode: natural?.signalCode ?? null,
            stderr: stderrTail || undefined,
          })
          const detail = [
            msg,
            natural?.exitCode != null ? `exit=${natural.exitCode}` : undefined,
            natural?.signalCode ? `signal=${natural.signalCode}` : undefined,
            stderrTail || undefined,
          ]
            .filter(Boolean)
            .join("; ")
          return Effect.succeed({ client: undefined, status: { status: "failed", error: detail } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(function* (
      key: string,
      mcp: ConfigMCP.Info,
      identity?: { hostRevision?: string; fromHost: boolean },
      launchEnv?: Record<string, string>,
    ) {
      if (mcp.enabled === false) {
        log.info("mcp server disabled", { key })
        return DISABLED_RESULT
      }

      log.info("found", { key, type: mcp.type })

      const {
        client: mcpClient,
        status,
        env,
      }: { client: MCPClient | undefined; status: Status; env?: Record<string, string> } =
        mcp.type === "remote"
          ? yield* connectRemote(key, mcp as ConfigMCP.Info & { type: "remote" }, identity)
          : yield* connectLocal(key, mcp as ConfigMCP.Info & { type: "local" }, launchEnv)

      if (!mcpClient) {
        return { status } satisfies CreateResult
      }

      // Ownership stays with this acquire/use/release until create() returns:
      // interruption during tools/list must close the unpublished client.
      const listed = yield* Effect.acquireUseRelease(
        Effect.succeed(mcpClient),
        (client) => defs(key, client, mcp.timeout),
        (client, exit) =>
          Exit.isFailure(exit) ? Effect.tryPromise(() => client.close()).pipe(Effect.ignore) : Effect.void,
      )
      if (!listed) {
        yield* Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore)
        return { status: { status: "failed", error: "Failed to get tools" } } satisfies CreateResult
      }

      log.info("create() successfully created client", { key, toolCount: listed.length })
      return {
        mcpClient,
        status,
        defs: listed,
        launch: { mcp, env, fromHost: identity?.fromHost === true },
      } satisfies CreateResult
    })
    const cfgSvc = yield* Config.Service

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        while (queue.length > 0) {
          const current = queue.shift()!
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    /** Close a replaced or suspended client once its in-flight requests and turn bindings release it. */
    function retireClient(s: State, client: MCPClient, bridge: EffectBridge.Shape) {
      s.retired.add(client)
      client.retire(() =>
        bridge.promise(
          Effect.gen(function* () {
            // Kill descendants while the parent PID is still valid; transport
            // close only reaps the direct child.
            const pid = client.transport instanceof ObservingStdioTransport ? client.transport.pid : null
            if (typeof pid === "number") {
              const pids = yield* descendants(pid)
              for (const dpid of pids) {
                try {
                  process.kill(dpid, "SIGTERM")
                } catch {}
              }
            }
            yield* McpSampling.cancelAll(client)
            yield* Effect.tryPromise(() => client.close())
          }).pipe(
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                s.retired.delete(client)
              }),
            ),
          ),
        ),
      )
    }

    /** Dormant: still listed with its last tool schema, but its process is gone until the next use. */
    const isDormant = (s: State, name: string) =>
      !!s.defs[name] && !s.clients[name] && s.status[name]?.status === "connected"

    /** Drop everything kept for serving or restarting a server's tools. */
    function forget(s: State, name: string) {
      delete s.defs[name]
      delete s.launch[name]
      delete s.revival[name]
    }

    function watch(
      s: State,
      name: string,
      client: MCPClient,
      bridge: EffectBridge.Shape,
      timeout?: number,
      sampling?: ConfigMCP.Info["sampling"],
    ) {
      // A server that exits on its own goes dormant instead of staying bound to a dead client.
      client.onclose = () => {
        if (s.clients[name] !== client) return
        log.info("mcp connection closed; restarting on next use", { server: name })
        delete s.clients[name]
      }
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        log.info("tools list changed notification received", { server: name })
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(defs(name, client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
      // Bind the effective policy for this generation so host deny is not
      // re-resolved from user config alone at sampling time.
      McpSampling.serve(name, client, bridge, undefined, undefined, sampling)
      McpElicitation.serve(name, client, bridge)
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        // Snapshot config and per-name revisions in one sync block so identity
        // always pairs the same generation with the same config object (R009).
        const host = HostMcp.get()
        const hostRevisions = new Map(
          Object.keys(host).map((name) => [name, HostMcp.revisionOf(name)] as const),
        )
        const config = { ...cfg.mcp, ...host }
        const s: State = {
          host: Object.fromEntries(Object.entries(host).map(([key, value]) => [key, JSON.stringify(value)])),
          hostRetryAt: {},
          retired: new Set(),
          refresh: Semaphore.makeUnsafe(1),
          status: {},
          clients: {},
          defs: {},
          launch: {},
          revival: {},
          scope: yield* Effect.scope,
          settled: yield* Deferred.make<void>(),
        }

        // Registered before the connection fiber is forked: finalizers run in
        // reverse order, so in-flight connections are interrupted first and this
        // then closes whatever they managed to store.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(
              [...Object.values(s.clients), ...s.retired],
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof ObservingStdioTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  yield* McpSampling.cancelAll(client)
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                }),
              { concurrency: "unbounded" },
            )
            pendingOAuthTransports.clear()
          }),
        )

        for (const [key, mcp] of Object.entries(config)) {
          if (isMcpConfigured(mcp) && mcp.enabled !== false) s.status[key] = { status: "pending" }
        }

        // Connect in the background so state initialization (and therefore the
        // first prompt) never waits on the slowest server. `settled` completes
        // once every attempt has finished; `tools()` waits on it with a bound.
        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                log.error("Ignoring MCP config entry without type", { key })
                return
              }

              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              const fromHost = key in host
              const hostRevision = hostRevisions.get(key)
              const result = yield* create(key, mcp, { fromHost, hostRevision }).pipe(Effect.catch(() => Effect.void))
              if (!result) return

              if (result.mcpClient) {
                // Status is written only on successful admit/commit (R013).
                // Pre-writing connected would survive a reject-stale discard.
                // Uninterruptible so a connected client is never orphaned
                // between creation and registration.
                yield* Effect.uninterruptible(
                  storeClient(
                    s,
                    key,
                    result.mcpClient,
                    result.defs!,
                    mcp.timeout,
                    hostEffectiveSampling(mcp, fromHost),
                    { fromHost, hostRevision, launch: result.launch },
                  ),
                )
                return
              }

              s.status[key] = result.status
              if (fromHost && result.status.status === "failed") s.hostRetryAt[key] = Date.now() + 5000
            }).pipe(
              // A rejected or errored attempt writes no status; drop the
              // placeholder so it reads as before (absent) rather than pending forever.
              Effect.ensuring(
                Effect.sync(() => {
                  if (s.status[key]?.status === "pending") delete s.status[key]
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        ).pipe(
          Effect.ensuring(Deferred.succeed(s.settled, undefined)),
          Effect.forkIn(s.scope, { startImmediately: true }),
        )

        return s
      }),
    )

    // Every accessor except `tools()` observes the fully settled state, so
    // connect/disconnect/add never race the background startup connections.
    const getState = Effect.fnUntraced(function* () {
      const s = yield* InstanceState.get(state)
      yield* Deferred.await(s.settled)
      return s
    })

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      forget(s, name)
      if (!client) return Effect.void
      // Interrupt sampling still running for this client first: once the
      // transport is gone its response can never be delivered, so the fiber
      // would otherwise keep a model call alive with nowhere to send the result.
      return McpSampling.cancelAll(client).pipe(
        Effect.andThen(Effect.tryPromise(() => client.close()).pipe(Effect.ignore)),
      )
    }

    // Refresh only embedder-owned servers. Requests and turn bindings retain
    // their original connection until completion, then retired clients close.
    const refreshHost = Effect.fn("MCP.refreshHost")(function* (s: State) {
      yield* s.refresh.withPermits(1)(
        Effect.gen(function* () {
          const host = HostMcp.get()
          const cfg = yield* cfgSvc.get()
          const bridge = yield* EffectBridge.make()
          // hostRetryAt keeps failed fallbacks reachable after an override is removed.
          for (const name of new Set([...Object.keys(s.host), ...Object.keys(host), ...Object.keys(s.hostRetryAt)])) {
            const revision = JSON.stringify(host[name])
            if (s.host[name] === revision && (!s.hostRetryAt[name] || Date.now() < s.hostRetryAt[name])) continue
            const mcp = host[name] ?? cfg.mcp?.[name]
            const result =
              !mcp || !isMcpConfigured(mcp) || mcp.enabled === false
                ? { status: { status: "disabled" as const }, mcpClient: undefined, defs: undefined }
                : yield* create(name, mcp)
            const previous = s.clients[name]
            if (previous) retireClient(s, previous, bridge)
            delete s.clients[name]
            forget(s, name)
            s.status[name] = result.status
            if (revision == null) delete s.host[name]
            else s.host[name] = revision
            if (result.status.status === "failed") s.hostRetryAt[name] = Date.now() + 5000
            else delete s.hostRetryAt[name]
            if (result.mcpClient) {
              s.clients[name] = result.mcpClient
              s.defs[name] = result.defs!
              s.launch[name] = { ...result.launch!, fromHost: name in host }
              watch(s, name, result.mcpClient, bridge, mcp?.timeout, hostEffectiveSampling(mcp, name in host))
            }
          }
        }),
      )
    })

    function releaseMcpClient(client: MCPClient | undefined) {
      if (!client) return Effect.void
      return McpSampling.cancelAll(client).pipe(
        Effect.andThen(Effect.tryPromise(() => client.close()).pipe(Effect.ignore)),
      )
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      timeout?: number,
      sampling?: ConfigMCP.Info["sampling"],
      opts?: { fromHost?: boolean; hostRevision?: string; launch?: Launch },
    ) {
      const admit = () => {
        const hostNow = HostMcp.get()[name]
        if (opts?.fromHost) {
          if (!hostNow || hostNow.enabled === false) return "reject-disabled" as const
          if (opts.hostRevision != null && opts.hostRevision !== HostMcp.revisionOf(name)) {
            return "reject-stale" as const
          }
          return "ok" as const
        }
        if (hostNow != null) return "reject-owned" as const
        return "ok" as const
      }
      const discardAttempt = (fallback: Status) =>
        releaseMcpClient(client).pipe(Effect.as(s.status[name] ?? fallback))

      // reject-stale means a newer generation owns the name. Report that live
      // status when present; never fabricate "connected" if none is stored.
      const staleFallback: Status = { status: "disabled" }
      const first = admit()
      if (first !== "ok") {
        return yield* discardAttempt(first === "reject-stale" ? staleFallback : ({ status: "disabled" } as Status))
      }
      const second = admit()
      if (second !== "ok") {
        return yield* discardAttempt(second === "reject-stale" ? staleFallback : ({ status: "disabled" } as Status))
      }
      // Commit first, then release the previous client (R002). Closing previous
      // before commit can leave a dead registry entry if admission is refused.
      const previous = s.clients[name]
      const bridge = yield* EffectBridge.make()
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      if (opts?.launch) s.launch[name] = opts.launch
      delete s.hostRetryAt[name]
      watch(s, name, client, bridge, timeout, sampling)
      if (previous && previous !== client) {
        yield* releaseMcpClient(previous)
      }
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* getState()
      yield* refreshHost(s)

      const cfg = yield* cfgSvc.get()
      const config = { ...cfg.mcp, ...HostMcp.get() }
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* (context?: TurnContext) {
      if (context)
        return Object.fromEntries([...(turnClients.get(context) ?? [])].map(([client, entry]) => [entry.name, client]))
      const s = yield* getState()
      yield* refreshHost(s)
      return s.clients
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (
      name: string,
      mcp: ConfigMCP.Info,
      sampling?: ConfigMCP.Info["sampling"],
      opts?: { fromHost?: boolean; hostRevision?: string },
    ) {
      // Prefer revision captured at the config-resolution boundary (R006).
      const hostRevision = opts?.hostRevision ?? (HostMcp.get()[name] ? HostMcp.revisionOf(name) : undefined)
      const s = yield* getState()
      const result = yield* create(name, mcp, {
        fromHost: opts?.fromHost === true,
        hostRevision,
      })

      if (!result.mcpClient) {
        // Failure completion uses the same validity rule as success: a host-sourced
        // attempt that is no longer valid must not mutate the current connection.
        const hostNow = HostMcp.get()[name]
        if (opts?.fromHost) {
          const stillValidHost = !!hostNow
            && hostNow.enabled !== false
            && (hostRevision == null || hostRevision === HostMcp.revisionOf(name))
          if (!stillValidHost) {
            return s.status[name] ?? { status: "disabled" as const }
          }
          s.status[name] = result.status
          return result.status
        }
        if (hostNow == null) {
          s.status[name] = result.status
          // Close only the client we captured; do not delete a replacement by name.
          const victim = s.clients[name]
          yield* releaseMcpClient(victim)
          if (victim && s.clients[name] === victim) {
            delete s.clients[name]
            forget(s, name)
          }
        }
        return hostNow == null ? result.status : (s.status[name] ?? { status: "connected" as const })
      }

      // `sampling` must be computed with the same config snapshot as `mcp`.
      return yield* storeClient(s, name, result.mcpClient, result.defs!, mcp.timeout, sampling ?? mcp.sampling, {
        ...opts,
        hostRevision,
        launch: result.launch,
      })
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCP.Info) {
      // HostMcp owns readiness and connection shape for host-projected names.
      // User/SDK add must not replace or re-enable a host-owned entry.
      if (HostMcp.get()[name] != null) {
        log.error("MCP name is host-owned; add refused", { name })
        const s = yield* getState()
        // Return the real current status — do not fabricate "disabled".
        return { status: { ...s.status, [name]: s.status[name] ?? { status: "disabled" as const } } }
      }
      yield* createAndStore(name, mcp, undefined, { fromHost: false })
      const s = yield* getState()
      return { status: s.status }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const s = yield* getState()
      // Restarting a dormant server must not drop its tools when the restart fails.
      if (isDormant(s, name)) return yield* reviveNow(s, name)
      const resolved = yield* getMcpConfig(name)
      if (!resolved) {
        log.error("MCP config not found or invalid", { name })
        return
      }
      // Explicit connect must not lift a host closed gate.
      if (resolved.hostOwned && resolved.mcp.enabled === false) {
        log.error("MCP is host-owned and disabled; connect refused", { name })
        return
      }
      // Bind config + ownership + revision at the resolution boundary (R006).
      const hostRevision = resolved.hostOwned ? HostMcp.revisionOf(name) : undefined
      yield* createAndStore(
        name,
        { ...resolved.mcp, enabled: true },
        hostEffectiveSampling(resolved.mcp, resolved.hostOwned),
        { fromHost: resolved.hostOwned, hostRevision },
      )
    })

    // A dormant server's process was released by an idle suspend or exited on its own.
    // Neither may change the model-facing tool list, so it is restarted instead of being
    // reported as disabled. The restart reuses the command and environment of the first
    // connection; the tools the restarted server lists replace the kept definitions.
    const restart = Effect.fnUntraced(function* (s: State, name: string) {
      const launch = s.launch[name]
      const current = yield* getMcpConfig(name)
      const mcp = launch?.mcp ?? current?.mcp
      const fromHost = launch?.fromHost ?? current?.hostOwned ?? false
      // Removed or switched off while dormant: the tools go with it.
      if (!mcp || current?.mcp.enabled === false || (fromHost && !current?.hostOwned)) {
        forget(s, name)
        s.status[name] = { status: "disabled" }
        return
      }
      // The host republished this server while it was dormant: refreshHost owns that rebuild.
      if (fromHost && s.host[name] !== JSON.stringify(HostMcp.get()[name])) return
      const identity = { fromHost, hostRevision: fromHost ? HostMcp.revisionOf(name) : undefined }
      const result = yield* create(name, mcp, identity, launch?.env)
      if (result.mcpClient) {
        // Disconnected or rebuilt by someone else while this attempt was connecting.
        if (!isDormant(s, name)) return yield* releaseMcpClient(result.mcpClient)
        yield* storeClient(s, name, result.mcpClient, result.defs!, mcp.timeout, hostEffectiveSampling(mcp, fromHost), identity)
        if (s.clients[name]) delete s.revival[name]
        return
      }
      if (result.status.status === "needs_auth" || result.status.status === "needs_client_registration") {
        // Only the user can fix this, so it must show: the server leaves dormancy with the real status.
        forget(s, name)
        s.status[name] = result.status
        return
      }
      const revival = s.revival[name]
      if (!revival) return
      revival.failures++
      const delay = Math.min(REVIVE_BACKOFF * 2 ** (revival.failures - 1), REVIVE_BACKOFF_MAX)
      revival.retryAt = Date.now() + delay
      revival.error = result.status.status === "failed" ? result.status.error : result.status.status
      log.warn("dormant mcp server did not restart; keeping its tool list", {
        name,
        error: revival.error,
        retryInMs: delay,
      })
    })

    // Starts a background restart unless one is in flight or the server is backing off.
    // Returns the attempt only to the caller that started it, so each attempt is waited
    // on by a single tools() call; later calls publish restart-on-call tools right away.
    const revive = Effect.fnUntraced(function* (s: State, name: string, force = false) {
      if (!isDormant(s, name)) return undefined
      const revival = (s.revival[name] ??= { retryAt: 0, failures: 0 })
      if (revival.attempt || (!force && Date.now() < revival.retryAt)) return undefined
      const attempt = Deferred.makeUnsafe<void>()
      revival.attempt = attempt
      yield* restart(s, name).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            delete revival.attempt
            return Deferred.succeed(attempt, undefined)
          }),
        ),
        Effect.forkIn(s.scope, { startImmediately: true }),
      )
      return attempt
    })

    /** An explicit use (connect, tool call) restarts regardless of backoff and waits for the outcome. */
    const reviveNow = Effect.fnUntraced(function* (s: State, name: string) {
      yield* revive(s, name, true)
      const attempt = s.revival[name]?.attempt
      if (attempt) yield* Deferred.await(attempt)
    })

    const suspend = Effect.fn("MCP.suspend")(function* (name: string) {
      const s = yield* getState()
      const client = s.clients[name]
      if (!client || s.status[name]?.status !== "connected") return
      // Status, defs and launch stay, so the server reads as dormant. The process goes
      // once in-flight requests and turn bindings have released the client.
      delete s.clients[name]
      retireClient(s, client, yield* EffectBridge.make())
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      const s = yield* getState()
      yield* closeClient(s, name)
      delete s.clients[name]
      // Explicit disconnect supersedes any host-refresh cooldown; do not auto-revive.
      delete s.hostRetryAt[name]
      s.status[name] = { status: "disabled" }
    })

    const tools = Effect.fn("MCP.tools")(function* (context?: TurnContext) {
      const result: Record<string, Tool> = {}
      const s = yield* InstanceState.get(state)
      // Bounded wait: a slow or hung server must not hold the turn hostage. Servers
      // still connecting are left out of this call and picked up by a later one
      // (the prompt loop resolves tools every step and announces the delta).
      const settled = yield* Deferred.await(s.settled).pipe(
        Effect.timeoutOption(FIRST_TURN_WAIT),
        Effect.map(Option.isSome),
      )
      if (!settled) {
        log.info("MCP servers still connecting; continuing without them", {
          pending: Object.entries(s.status)
            .filter(([, status]) => status.status === "pending")
            .map(([name]) => name),
        })
      }
      yield* refreshHost(s)

      const cfg = yield* cfgSvc.get()
      const config = { ...cfg.mcp, ...HostMcp.get() }
      const defaultTimeout = cfg.experimental?.mcp_timeout

      const attempts = (yield* Effect.forEach(Object.keys(s.defs), (name) => revive(s, name))).filter(
        (attempt) => attempt !== undefined,
      )
      if (attempts.length) {
        yield* Effect.forEach(attempts, (attempt) => Deferred.await(attempt), {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.timeoutOption(REVIVE_WAIT))
      }
      const bridge = yield* EffectBridge.make()

      // Capture bindings synchronously: refresh must not retire a client between
      // selecting it and retaining the tool closures returned to a turn.
      for (const [clientName, listed] of Object.entries(s.defs)) {
        if (s.status[clientName]?.status !== "connected") continue
        const mcpConfig = config[clientName]
        const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : undefined
        // Still dormant: publish the same schema and restart on call.
        const client =
          s.clients[clientName] ??
          (async () => {
            await bridge.promise(reviveNow(s, clientName))
            const live = s.clients[clientName]
            if (!live) {
              const reason = s.revival[clientName]?.error
              throw new Error(
                `MCP server "${clientName}" is not running and could not be restarted` + (reason ? `: ${reason}` : ""),
              )
            }
            if (context) retainForTurn(context, clientName, live)
            return live
          })

        if (context && listed.length && typeof client !== "function") retainForTurn(context, clientName, client)
        const timeout = entry?.timeout ?? defaultTimeout
        for (const mcpTool of listed) {
          result[sanitize(clientName) + "_" + sanitize(mcpTool.name)] = convertMcpTool(
            mcpTool,
            client,
            timeout,
            context,
          )
        }
      }
      return result
    })

    // Bounded wait only on tools(); readiness is the unbound sibling used by
    // entry/server reminders and mcp_tool_search miss diagnostics. Never awaits settled.
    const readiness = Effect.fn("MCP.readiness")(function* () {
      const s = yield* InstanceState.get(state)
      const cfg = yield* cfgSvc.get()
      const config = { ...cfg.mcp, ...HostMcp.get() }
      const configuredKeys = Object.entries(config)
        .filter(([, mcp]) => isMcpConfigured(mcp))
        .map(([key]) => key)
      const servers = configuredKeys.map((name) => {
        const current = s.status[name] ?? { status: "disabled" as const }
        const listed = s.defs[name] ?? []
        const tools =
          current.status === "connected"
            ? listed.map((mcpTool) => ({
                name: sanitize(name) + "_" + sanitize(mcpTool.name),
                description: mcpTool.description ?? "",
              }))
            : undefined
        return {
          name,
          status: current.status,
          ...(current.status === "failed" || current.status === "needs_client_registration"
            ? { error: current.error }
            : {}),
          ...(current.status === "connected" ? { toolCount: listed.length } : {}),
          ...(tools ? { tools } : {}),
        }
      })
      return { configured: configuredKeys.length > 0, servers }
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client) => Promise<T[]>,
      label: string,
    ) {
      const connected = Object.entries(s.clients).filter(([name]) => s.status[name]?.status === "connected")
      const releases = connected.map(([, client]) => client.retain())
      return Effect.forEach(
        connected,
        ([clientName, client]) =>
          fetchFromClient(clientName, client, listFn, label).pipe(Effect.map((items) => Object.entries(items ?? {}))),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())),
        Effect.ensuring(
          Effect.sync(() => {
            for (const release of releases) release()
          }),
        ),
      )
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      const s = yield* getState()
      yield* refreshHost(s)
      return yield* collectFromConnected(s, (c) => c.listPrompts().then((r) => r.prompts), "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* () {
      const s = yield* getState()
      yield* refreshHost(s)
      return yield* collectFromConnected(s, (c) => c.listResources().then((r) => r.resources), "resources")
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* getState()
      yield* refreshHost(s)
      const client = s.clients[clientName]
      if (!client) {
        log.warn(`client not found for ${label}`, { clientName })
        return undefined
      }
      const release = client.retain()
      return yield* Effect.tryPromise({
        try: () => fn(client),
        catch: (e: any) => {
          log.error(`failed to ${label}`, { clientName, ...meta, error: e?.message })
          return e
        },
      }).pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.ensuring(Effect.sync(release)),
      )
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(clientName, (client) => client.getPrompt({ name, arguments: args }), "getPrompt", {
        promptName: name,
      })
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(clientName, (client) => client.readResource({ uri: resourceUri }), "readResource", {
        resourceUri,
      })
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const cfg = yield* cfgSvc.get()
      const hostEntry = HostMcp.get()[mcpName]
      const mcpConfig = hostEntry ?? cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      // Capture ownership with the config object so async connect cannot re-bind
      // sampling to a later HostMcp revision.
      return { mcp: mcpConfig, hostOwned: hostEntry != null }
    })

    const startAuthInternal = Effect.fn("MCP.startAuthInternal")(function* (mcpName: string) {
      const resolved = yield* getMcpConfig(mcpName)
      const mcpConfig = resolved?.mcp
      if (!mcpConfig) throw new Error(`MCP server ${mcpName} not found or disabled`)
      // Auth must not open or complete a connection that Host closed.
      if (resolved.hostOwned && mcpConfig.enabled === false) {
        throw new Error(`MCP server ${mcpName} is host-owned and disabled`)
      }
      // Capture attempt identity at the start of auth, not after connect completes (R003).
      const hostRevisionAtStart = resolved.hostOwned ? HostMcp.revisionOf(mcpName) : undefined
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(oauthConfig?.redirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: oauthConfig?.redirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), { authProvider })

      return yield* Effect.tryPromise({
        try: () => {
          const client = createClient()
          return client.connect(transport).then(
            () =>
              ({
                kind: "connected",
                oauthState,
                client,
                resolved,
                hostRevision: hostRevisionAtStart,
              }) satisfies AuthResult,
          )
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            // Same identity-bound publish as connectRemote (R007).
            publishPendingOAuthAttempt(mcpName, {
              transport,
              hostRevision: hostRevisionAtStart,
              fromHost: resolved.hostOwned,
            })
            return Effect.succeed({
              kind: "redirect",
              authorizationUrl: capturedUrl.toString(),
              oauthState,
            } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    /** Public HTTP/SDK shape: never includes the live client or effective config snapshot. */
    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const result = yield* startAuthInternal(mcpName)
      if (result.kind === "connected") {
        // This public probe does not transfer its client to the connection registry.
        yield* auth
          .clearOAuthState(mcpName)
          .pipe(Effect.ensuring(Effect.tryPromise(() => result.client.close()).pipe(Effect.ignore)))
        return { authorizationUrl: "", oauthState: result.oauthState }
      }
      return { authorizationUrl: result.authorizationUrl, oauthState: result.oauthState }
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (mcpName: string) {
      const result = yield* startAuthInternal(mcpName)
      if (result.kind === "connected") {
        const { client, resolved } = result

        const listed = yield* defs(mcpName, client, resolved.mcp.timeout)
        if (!listed) {
          yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
          return { status: "failed", error: "Failed to get tools" } as Status
        }

        const s = yield* getState()
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(
          s,
          mcpName,
          client,
          listed,
          resolved.mcp.timeout,
          hostEffectiveSampling(resolved.mcp, resolved.hostOwned),
          { fromHost: resolved.hostOwned, hostRevision: result.hostRevision },
        )
      }

      log.info("opening browser for oauth", { mcpName, url: result.authorizationUrl, state: result.oauthState })

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)

      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          log.warn("failed to open browser, user must open URL manually", { mcpName })
          return bus.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      const attempt = pendingOAuthTransports.get(mcpName)
      if (!attempt) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)
      const { transport, hostRevision, fromHost } = attempt

      const result = yield* Effect.tryPromise({
        try: () => transport.finishAuth(authorizationCode).then(() => true as const),
        catch: (error) => {
          log.error("failed to finish oauth", { mcpName, error })
          return error
        },
      }).pipe(Effect.option)

      if (Option.isNone(result)) {
        return { status: "failed", error: "OAuth completion failed" } as Status
      }

      // Stale/attempt-replaced completion must not clear the new flow's verifier
      // or publish a connection (R007).
      if (pendingOAuthTransports.get(mcpName) !== attempt) {
        log.info("stale oauth completion ignored", { mcpName })
        return { status: "failed", error: "OAuth attempt superseded" } as Status
      }
      pendingOAuthTransports.delete(mcpName)
      yield* auth.clearCodeVerifier(mcpName)

      const resolved = yield* getMcpConfig(mcpName)
      if (!resolved) return { status: "failed", error: "MCP config not found after auth" } as Status

      return yield* createAndStore(mcpName, resolved.mcp, hostEffectiveSampling(resolved.mcp, fromHost), {
        fromHost,
        hostRevision,
      })
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
      log.info("removed oauth credentials", { mcpName })
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const resolved = yield* getMcpConfig(mcpName)
      if (!resolved) return false
      return resolved.mcp.type === "remote" && resolved.mcp.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      if (!entry?.tokens) return "not_authenticated" as AuthStatus
      const expired = yield* auth.isTokenExpired(mcpName)
      return (expired ? "expired" : "authenticated") as AuthStatus
    })

    return Service.of({
      status,
      clients,
      tools,
      readiness,
      prompts,
      resources,
      add,
      connect,
      disconnect,
      suspend,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

export const defaultLayer = layer.pipe(
  Layer.provide(McpAuth.layer),
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as MCP from "."
