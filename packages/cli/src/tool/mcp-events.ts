import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Config } from "@/config"
import { EffectBridge, InstanceState } from "@/effect"
import { Log } from "@/util"
import { startLocalEvents } from "@/mcp/events-runtime"

const parameters = z.object({
  operation: z.enum(["subscribe", "unsubscribe"]),
  server: z.string().min(1).max(128),
  event: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).optional(),
})

// Kept within this process: opt-in must be explicitly renewed after restart.
const log = Log.create({ service: "mcp.events" })

export const McpEventsTool = Tool.define(
  "mcp_events",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const connections = yield* InstanceState.make(
      Effect.fn("McpEventsTool.connections")(function* () {
        const active = new Map<string, () => Promise<void>>()
        yield* Effect.addFinalizer(() => Effect.promise(async () => {
          const closers = [...active.values()]
          active.clear()
          await Promise.allSettled(closers.map((close) => close()))
        }))
        return active
      }),
    )
    return {
      description: "Subscribe the current session to a local MCP server's experimental SEP-3415 push event, or unsubscribe. Requires the user's explicit confirmation. External events may wake this session.",
      parameters,
      execute: (input: z.infer<typeof parameters>, ctx: Tool.Context) => Effect.gen(function* () {
        if (ctx.actorID && ctx.actorID !== "main") throw new Error("Only the main session can manage MCP event subscriptions")
        const active = yield* InstanceState.get(connections)
        const key = JSON.stringify([ctx.sessionID, input.server, input.event, input.arguments ?? {}])
        if (input.operation === "unsubscribe") {
          const close = active.get(key)
          active.delete(key)
          if (close) yield* Effect.promise(close)
          return { title: "MCP event unsubscribed", output: close ? "Subscription stopped." : "No active subscription.", metadata: {} }
        }
        const cfg = yield* config.get()
        const server = cfg.mcp?.[input.server]
        if (!server || !("type" in server) || server.type !== "local" || server.enabled === false)
          throw new Error("An enabled local MCP server is required; remote MCP Events are not supported yet")
        // Do not silently grant event-triggered model/tool execution based on an MCP config.
        yield* ctx.ask({ permission: "mcp_events", patterns: [`${input.server}:${input.event}:${ctx.sessionID}`], always: [], metadata: { server: input.server, event: input.event, sessionID: ctx.sessionID, arguments: input.arguments ?? {} } })
        if (active.has(key)) return { title: "MCP event subscribed", output: "Subscription already active.", metadata: {} }
        const bridge = yield* EffectBridge.make()
        const cwd = yield* InstanceState.directory
        const pending = () => Promise.resolve()
        active.set(key, pending)
        let ended = false
        const close = yield* Effect.tryPromise({
          try: () => startLocalEvents({
            server: input.server, config: server, cwd,
            subscriptions: [{ name: input.event, sessionID: ctx.sessionID, arguments: input.arguments }], bridge,
            onError: (error) => log.warn("MCP event subscription error", { server: input.server, error: error.message }),
            onClose: () => { ended = true; active.delete(key) },
          }),
          catch: (error) => error instanceof Error ? error : new Error(String(error)),
        }).pipe(Effect.tapError(() => Effect.sync(() => { active.delete(key) })), Effect.orDie)
        if (ended || active.get(key) !== pending) {
          yield* Effect.promise(close)
          throw new Error("Subscription ended during setup")
        }
        active.set(key, close)
        return { title: "MCP event subscribed", output: "Subscription active for this session. It stops when the process exits; reconnect and re-authorize after restart.", metadata: {} }
      }),
    }
  }),
)
