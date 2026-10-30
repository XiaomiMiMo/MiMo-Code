import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Semaphore } from "effect"
import { createHash } from "node:crypto"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import * as Storage from "@/storage/storage"
import { Log } from "@/util"
import { mcpRequestTimeout } from "./apps"

const log = Log.create({ service: "mcp.app-calls" })

const Call = z.object({
  sessionID: z.string(),
  messageID: z.string(),
  callID: z.string(),
  server: z.string(),
  tool: z.string(),
  resourceUri: z.string().startsWith("ui://").optional(),
  arguments: z.unknown(),
  /** Issue order: assigned once the call is admitted and about to reach the MCP Client. */
  callOrder: z.number(),
  timeoutMs: z.number(),
})
export type AppCall = z.infer<typeof Call>
export type AppOutcome = { result: CallToolResult } | { cancelled: string }
export type SettledAppCall = AppCall &
  ({ result: CallToolResult; cancelled?: never } | { cancelled: string; result?: never })

export const AppToolStarted = BusEvent.define("mcp.app.tool.started", Call)
export const AppToolCompleted = BusEvent.define(
  "mcp.app.tool.completed",
  Call.extend({ cancelled: z.string().optional(), result: z.unknown().optional() }),
)

/** One recoverable input/result pair per session + Server; never a call history. */
export interface AppCallSlot {
  server: string
  resourceUri: string
  /** Tool row carrying the conversation entry; page calls have no row and never move it. */
  anchor: { messageID: string; callID: string; callOrder: number }
  call: SettledAppCall
}

const key = (session: string, server: string) => [
  "mcp-app-call",
  session,
  createHash("sha256").update(server).digest("hex"),
]

// Epoch-based so orders keep increasing across restarts without persisting a counter.
let lastOrder = 0
const nextOrder = () => (lastOrder = Math.max(Date.now() * 1000, lastOrder + 1))
const inflight = new Map<string, Map<string, AppCall>>()
const writes = Semaphore.makeUnsafe(1)

export const readAppCall = (session: string, server: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    return yield* storage.read<AppCallSlot>(key(session, server))
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

/** Consistent view for a new page: calls issued up to `watermark` and not in flight are history. */
export function appCallSnapshot(session: string) {
  return { watermark: lastOrder, inflight: [...(inflight.get(session)?.values() ?? [])] }
}

/** Register and announce the call before it is sent, so hosts can hold later results behind it. */
export const startAppCall = (input: Omit<AppCall, "callOrder" | "resourceUri" | "timeoutMs"> & { resourceUri?: string; timeoutMs?: number }) =>
  Effect.gen(function* () {
    const resourceUri = input.resourceUri ?? (yield* readAppCall(input.sessionID, input.server))?.resourceUri
    const call: AppCall = { ...input, ...(resourceUri ? { resourceUri } : {}), callOrder: nextOrder(), timeoutMs: mcpRequestTimeout(input.timeoutMs) }
    const calls = inflight.get(call.sessionID) ?? new Map<string, AppCall>()
    calls.set(call.callID, call)
    inflight.set(call.sessionID, calls)
    const bus = yield* Bus.Service
    yield* bus.publish(AppToolStarted, call)
    return call
  })

/**
 * Exactly one terminal per started call. The slot is written before the call leaves the
 * in-flight set, so a snapshot never sees it in neither place.
 */
export const settleAppCall = (call: AppCall, outcome: AppOutcome, entry: "row" | "page") =>
  Effect.gen(function* () {
    yield* writes
      .withPermits(1)(
        Effect.gen(function* () {
          if (!inflight.get(call.sessionID)?.has(call.callID)) return // session deleted meanwhile
          const storage = yield* Storage.Service
          const slot = yield* readAppCall(call.sessionID, call.server)
          // A call issued before the first slot existed still inherits its resource here.
          const resourceUri = call.resourceUri ?? slot?.resourceUri
          if (!resourceUri) return
          // The row's own identity decides whether it can become the entry, matching what the renderer sees.
          const moveAnchor = entry === "row" && !!call.resourceUri && (!slot || call.callOrder > slot.anchor.callOrder)
          const anchor = moveAnchor
            ? { messageID: call.messageID, callID: call.callID, callOrder: call.callOrder }
            : slot?.anchor
          // Only a conversation row can create a slot; page calls without one have nothing to anchor to.
          if (!anchor) return
          const replace = !slot || call.callOrder > slot.call.callOrder
          if (!moveAnchor && !replace) return
          yield* storage.write(key(call.sessionID, call.server), {
            server: call.server,
            resourceUri: replace || !slot ? resourceUri : slot.resourceUri,
            anchor,
            call: replace || !slot ? ({ ...call, resourceUri, ...outcome } as SettledAppCall) : slot.call,
          } satisfies AppCallSlot)
        }),
      )
      .pipe(Effect.catch((error) => Effect.sync(() => log.warn("App call slot write failed", { error }))))
    const calls = inflight.get(call.sessionID)
    calls?.delete(call.callID)
    if (calls && !calls.size) inflight.delete(call.sessionID)
    const bus = yield* Bus.Service
    yield* bus.publish(AppToolCompleted, { ...call, ...outcome })
  })

export const clearAppCalls = (session: string) =>
  writes.withPermits(1)(
    Effect.gen(function* () {
      inflight.delete(session)
      const storage = yield* Storage.Service
      const keys = yield* storage.list(["mcp-app-call", session])
      yield* Effect.forEach(keys, (key) => storage.remove(key), { discard: true })
    }),
  )

/** Read-only reconciliation; the single slot is never expanded into a result history. */
export const appCallStatus = (session: string, ref: Pick<AppCall, "server" | "messageID" | "callID" | "callOrder">) =>
  Effect.gen(function* () {
    const matches = (call?: AppCall) => call?.server === ref.server && call.messageID === ref.messageID &&
      call.callID === ref.callID && call.callOrder === ref.callOrder
    if (matches(inflight.get(session)?.get(ref.callID))) return { status: "running" as const }
    const slot = yield* readAppCall(session, ref.server)
    return matches(slot?.call)
      ? { status: "completed" as const, call: slot!.call }
      : { status: "missing" as const }
  })

export function appOutcome(error: unknown, aborted: boolean): AppOutcome {
  const message = error instanceof Error ? error.message : String(error)
  return aborted
    ? { cancelled: message || "Tool cancelled" }
    : { result: { content: [{ type: "text", text: message || "MCP tool execution failed" }], isError: true } }
}
