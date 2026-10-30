import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Config } from "@/config"
import { EffectBridge, InstanceState } from "@/effect"
import { Log } from "@/util"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { startLocalEvents } from "@/mcp/events-runtime"
import { HostMcp } from "@/mcp/host"

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
    const bus = yield* Bus.Service
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
        if (ctx.abort.aborted) throw new Error("MCP event subscription cancelled")
        if (Buffer.byteLength(JSON.stringify(input.arguments ?? {}), "utf8") > 16 * 1024)
          throw new Error("MCP event subscription arguments exceed size limit")
        const cfg = yield* config.get()
        const server = HostMcp.get()[input.server] ?? cfg.mcp?.[input.server]
        if (!server || !("type" in server) || server.type !== "local" || server.enabled === false)
          throw new Error("An enabled local MCP server is required; remote MCP Events are not supported yet")
        // Do not silently grant event-triggered model/tool execution based on an MCP config.
        yield* ctx.ask({ permission: "mcp_events", patterns: [`${input.server}:${input.event}:${ctx.sessionID}`], always: [], metadata: { server: input.server, event: input.event, sessionID: ctx.sessionID, arguments: input.arguments ?? {} } })
        if (ctx.abort.aborted) throw new Error("MCP event subscription cancelled")
        const latest = yield* config.get()
        const currentServer = HostMcp.get()[input.server] ?? latest.mcp?.[input.server]
        if (JSON.stringify(currentServer) !== JSON.stringify(server)) throw new Error("MCP server configuration changed during approval; subscribe again")
        if (active.has(key)) return { title: "MCP event subscribed", output: "Subscription already active.", metadata: {} }
        if (active.size >= 16) throw new Error("Too many active MCP event subscriptions in this workspace")
        const bridge = yield* EffectBridge.make()
        const cwd = yield* InstanceState.directory
        const pending = () => Promise.resolve()
        active.set(key, pending)
        let ended = false
        let closeHandle: (() => Promise<void>) | undefined
        const close = yield* Effect.tryPromise({
          try: () => startLocalEvents({
            server: input.server, config: server, cwd,
            subscriptions: [{ name: input.event, sessionID: ctx.sessionID, arguments: input.arguments }], bridge,
            onError: () => log.warn("MCP event subscription failed", { server: input.server }),
            onClose: () => {
              ended = true
              if (active.get(key) === pending || active.get(key) === closeHandle) active.delete(key)
              void bridge.promise(bus.publish(TuiEvent.ToastShow, {
                title: "MCP event subscription stopped",
                message: `Subscription for ${input.server} ended; events may be missed. Subscribe again to resume.`,
                variant: "warning",
                duration: 8000,
              }).pipe(Effect.ignore)).catch(() => {})
            },
          }),
          catch: (error) => error instanceof Error ? error : new Error(String(error)),
        }).pipe(Effect.tapError(() => Effect.sync(() => { if (active.get(key) === pending) active.delete(key) })), Effect.orDie)
        closeHandle = close
        if (ctx.abort.aborted || ended || active.get(key) !== pending) {
          yield* Effect.promise(close)
          if (active.get(key) === pending) active.delete(key)
          throw new Error("Subscription was cancelled or ended during setup")
        }
        active.set(key, close)
        return { title: "MCP event subscribed", output: "Subscription active for this session. It stops when the process exits; reconnect and re-authorize after restart.", metadata: {} }
      }),
    }
  }),
)
