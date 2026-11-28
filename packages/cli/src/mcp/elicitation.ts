import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  CancelledNotificationSchema,
  ElicitRequestSchema,
  ErrorCode,
  McpError,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js"
import { Effect, Exit, Fiber } from "effect"
import type { EffectBridge } from "@/effect"
import { Question } from "@/question"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Log } from "@/util"
import { McpElicitationForm } from "./elicitation-form"
import type { McpElicitationRecord, McpElicitationRecorder } from "./tool-context"

export * as McpElicitation from "./elicitation"

const log = Log.create({ service: "mcp.elicitation" })

/** Same key as MCP.TURN_LIFECYCLE_CAPABILITY (kept local to avoid an import cycle). */
const TURN_LIFECYCLE_KEY = "com.xiaomi.mimo/turn-lifecycle"
const MAX_META_BYTES = 16 * 1024
const MAX_SCHEMA_BYTES = 64 * 1024

export interface CallScope {
  turnID?: string
  callID?: string
  messageID?: string
  record?: McpElicitationRecorder
}

interface Call extends CallScope {
  sessionID?: SessionID
  controller: AbortController
  /** Another call on the same client ran at the same time. */
  overlapped: boolean
}
const calls = new WeakMap<Client, Set<Call>>()

/**
 * Register a tool call in flight on `client`. An elicitation is answered only
 * when it can be associated with exactly one such call (MCP requires server
 * requests to belong to an originating client request; on stdio the protocol
 * carries no parent id, so association uses the call identity the server echoes
 * back in the turn-lifecycle `_meta`, or else the only call in flight).
 * Returns the function that ends the call and withdraws its pending prompts.
 */
export function beginCall(client: Client, sessionID?: string, signal?: AbortSignal, scope: CallScope = {}) {
  const active = calls.get(client) ?? new Set<Call>()
  calls.set(client, active)
  const call: Call = {
    ...scope,
    sessionID: sessionID ? SessionID.make(sessionID) : undefined,
    controller: new AbortController(),
    overlapped: false,
  }
  const abort = () => call.controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  if (active.size) {
    // Without an echoed identity, overlapping calls cannot be told apart.
    call.overlapped = true
    for (const other of active) other.overlapped = true
  }
  active.add(call)
  return () => {
    abort()
    signal?.removeEventListener("abort", abort)
    active.delete(call)
  }
}

export function cancelAll(client: Client) {
  for (const call of calls.get(client) ?? []) call.controller.abort()
}

function identity(meta: unknown) {
  if (!meta || typeof meta !== "object") return undefined
  const value = (meta as Record<string, unknown>)[TURN_LIFECYCLE_KEY]
  if (!value || typeof value !== "object") return undefined
  const { sessionId, turnId, callId } = value as Record<string, unknown>
  const text = (item: unknown) => (typeof item === "string" && item ? item : undefined)
  const result = { sessionId: text(sessionId), turnId: text(turnId), callId: text(callId) }
  return result.sessionId || result.callId ? result : undefined
}

/** The single call a request belongs to, or undefined when none or several match. */
export function resolve(client: Client, meta: unknown): Call | undefined {
  const all = [...(calls.get(client) ?? [])]
  const named = identity(meta)
  const candidates = named?.callId
    ? all.filter((call) => call.callID === named.callId && (!named.sessionId || call.sessionID === named.sessionId))
    : named?.sessionId
      ? all.filter((call) => call.sessionID === named.sessionId && (!named.turnId || call.turnID === named.turnId))
      : all.length === 1 && !all[0].overlapped
        ? all
        : []
  return candidates.length === 1 ? candidates[0] : undefined
}

/**
 * The SDK ignores `notifications/cancelled` for request id 0 (`if (!requestId)`),
 * which is the id of a server's first request. Observe cancellations at the
 * transport boundary, leaving the SDK's own dispatch untouched.
 */
const cancellations = new WeakMap<Transport, Map<RequestId, AbortController>>()
function cancellation(client: Client, requestId: RequestId) {
  const transport = client.transport
  const controller = new AbortController()
  if (!transport) return { signal: controller.signal, done: () => {} }
  let pending = cancellations.get(transport)
  if (!pending) {
    const captured = new Map<RequestId, AbortController>()
    pending = captured
    cancellations.set(transport, captured)
    const dispatch = transport.onmessage
    transport.onmessage = (message, info) => {
      if (!("id" in message)) {
        const parsed = CancelledNotificationSchema.safeParse(message)
        if (parsed.success && parsed.data.params.requestId !== undefined)
          captured.get(parsed.data.params.requestId)?.abort()
      }
      dispatch?.(message, info)
    }
  }
  pending.get(requestId)?.abort()
  pending.set(requestId, controller)
  const map = pending
  return {
    signal: controller.signal,
    done: () => {
      if (map.get(requestId) === controller) map.delete(requestId)
    },
  }
}

function bounded(value: Record<string, unknown> | undefined, limit: number) {
  if (value === undefined) return undefined
  try {
    const text = JSON.stringify(value)
    return Buffer.byteLength(text, "utf8") <= limit ? (JSON.parse(text) as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

type Result = McpElicitationForm.Result

export function serve(server: string, client: Client, bridge: EffectBridge.Shape) {
  const onclose = client.onclose
  client.onclose = () => {
    cancelAll(client)
    onclose?.()
  }
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    const params = request.params
    // Only form mode is declared; the SDK rejects url mode before this handler.
    if (params.mode === "url") throw new McpError(ErrorCode.InvalidParams, "URL elicitation is not supported by this client.")
    const call = resolve(client, params._meta)
    if (!call?.sessionID) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Elicitation must be associated with exactly one in-flight tool call of this client.",
      )
    }

    const meta = bounded(params._meta as Record<string, unknown> | undefined, MAX_META_BYTES)
    const schema = params.requestedSchema as Record<string, unknown>
    const record: McpElicitationRecord = {
      id: PartID.ascending(),
      server,
      ...(call.callID ? { callID: call.callID } : {}),
      requestID: extra.requestId,
      mode: "form",
      message: params.message,
      requestedSchema: bounded(schema, MAX_SCHEMA_BYTES) ?? {},
      ...(meta ? { meta } : {}),
      time: { created: Date.now() },
    }
    const write = async (update: Partial<McpElicitationRecord>) => {
      if (!call.record) return
      Object.assign(record, update)
      await call.record({ ...record }).catch((error) => log.warn("elicitation record failed", { server, error }))
    }
    const finish = async (result: Result, update: Partial<McpElicitationRecord> = {}) => {
      await write({
        action: result.action,
        ...(result.action === "accept" ? { content: result.content } : {}),
        ...update,
        time: { ...record.time, completed: Date.now() },
      })
      return result
    }

    if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES) {
      await write({ error: "requestedSchema is too large", time: { ...record.time, completed: Date.now() } })
      throw new McpError(ErrorCode.InvalidParams, "requestedSchema is too large")
    }
    const subtitle = params._meta?.subtitle
    const form = McpElicitationForm.build(server, params.message, schema, typeof subtitle === "string" ? subtitle : undefined)
    if (typeof form === "string") {
      await write({ error: form, time: { ...record.time, completed: Date.now() } })
      throw new McpError(ErrorCode.InvalidParams, `Unsupported elicitation form: ${form}`)
    }

    const cancelled = cancellation(client, extra.requestId)
    const signal = AbortSignal.any([call.controller.signal, extra.signal, cancelled.signal])
    try {
      if (signal.aborted) return await finish({ action: "cancel" }, { error: "cancelled" })
      await write({})
      const fiber = bridge.fork(
        Effect.gen(function* () {
          const question = yield* Question.Service
          return yield* question.askElicitation({
            sessionID: call.sessionID!,
            questions: form.questions.map((item) => ({ ...item, options: [...item.options] })),
            elicitation: {
              server,
              requestID: extra.requestId,
              mode: "form",
              message: params.message,
              requestedSchema: record.requestedSchema,
              ...(meta ? { meta } : {}),
            },
            ...(call.messageID && call.callID
              ? { tool: { messageID: MessageID.make(call.messageID), callID: call.callID } }
              : {}),
          })
        }),
      )
      const abort = () => {
        void Effect.runPromise(Fiber.interrupt(fiber))
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      try {
        const exit = await Effect.runPromise(Fiber.await(fiber))
        if (signal.aborted) return await finish({ action: "cancel" }, { error: "cancelled" })
        if (!Exit.isSuccess(exit)) return await finish({ action: "cancel" })
        const replied = exit.value
        const answered = {
          ...(replied.source !== undefined ? { source: replied.source } : {}),
          ...(replied.reason !== undefined ? { reason: replied.reason } : {}),
        }
        if (replied.elicitation) {
          const { action, content } = replied.elicitation
          if (action !== "accept") return await finish({ action }, answered)
          const checked = form.validate(content ?? {})
          if (!checked.ok) return await finish({ action: "cancel" }, { ...answered, error: checked.error })
          return await finish({ action: "accept", content: checked.content }, answered)
        }
        const decoded = form.decode(replied.answers)
        if ("error" in decoded) return await finish({ action: "cancel" }, { ...answered, error: decoded.error })
        return await finish(decoded, answered)
      } finally {
        signal.removeEventListener("abort", abort)
      }
    } finally {
      cancelled.done()
    }
  })
}
