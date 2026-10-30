import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

/** SEP-3415 proposal revision b08e4f9; stdio only. No legacy initialize or top-level events capability. */
export const EVENTS_EXTENSION = "io.modelcontextprotocol/events"
export const EVENTS_PROTOCOL_VERSION = "2026-07-28"
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId"
const MAX_LINE_BYTES = 1024 * 1024

type JsonObject = Record<string, unknown>
type RpcId = string | number

export interface EventDescriptor {
  name: string
  delivery: string[]
  inputSchema: JsonObject
  payloadSchema: JsonObject
  description?: string
}

export interface EventOccurrence {
  eventId: string
  name: string
  timestamp: string
  data: JsonObject
  cursor?: string | null
}

export interface StreamCallbacks {
  onActive?: (info: { cursor: string | null; truncated: boolean }) => void
  onEvent: (event: EventOccurrence) => void | Promise<void>
  onHeartbeat?: (cursor: string | null) => void
  onError?: (error: Error, terminal: boolean) => void
  onClose?: (reason: "cancelled" | "ended" | "terminated" | "error") => void
}

export interface EventsSubscription {
  readonly id: RpcId
  readonly ready: Promise<void>
  cancel(): Promise<void>
}

export interface EventsStdioOptions {
  command: string
  args?: string[]
  cwd?: string
  /** Caller must construct the child environment explicitly; no credentials are inferred. */
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  /** No event or heartbeat for this long terminates the stream; caller may reconnect with its committed cursor. */
  heartbeatTimeoutMs?: number
  /** Maximum queued callback invocations per stream before cancelling it. */
  maxPendingNotifications?: number
  onError?: (error: Error) => void
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface StreamState {
  name: string
  callbacks: StreamCallbacks
  active: boolean
  ready: Promise<void>
  readyResolve: () => void
  readyReject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  heartbeatTimer?: ReturnType<typeof setTimeout>
  processing: Promise<void>
  pendingNotifications: number
  finishReason?: "cancelled" | "ended" | "terminated" | "error"
  ending: boolean
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rpcError(value: unknown): Error {
  if (!object(value) || typeof value.code !== "number" || typeof value.message !== "string") {
    return new Error("Invalid JSON-RPC error response")
  }
  return new Error(`MCP error ${value.code}: ${value.message}`)
}

function cursor(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

/** Independent transport: never reuses the existing MCP 1.x client or sends legacy initialize. */
export class EventsStdioClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<RpcId, PendingRequest>()
  private readonly streams = new Map<RpcId, StreamState>()
  private readonly decoder = new StringDecoder("utf8")
  private buffer = ""
  private closed = false
  private nextId = 0
  private discovered = false
  private readonly timeout: number

  private constructor(private readonly options: EventsStdioOptions) {
    this.timeout = options.requestTimeoutMs ?? 10_000
    if (
      !Number.isFinite(this.timeout) ||
      this.timeout <= 0 ||
      (options.heartbeatTimeoutMs !== undefined &&
        (!Number.isFinite(options.heartbeatTimeoutMs) || options.heartbeatTimeoutMs <= 0)) ||
      (options.maxPendingNotifications !== undefined &&
        (!Number.isSafeInteger(options.maxPendingNotifications) || options.maxPendingNotifications < 1))
    ) {
      throw new Error("Invalid events client limits")
    }
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: process.platform === "win32",
    })
    this.child.stderr.resume()
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk))
    this.child.stdout.on("end", () => this.fail(new Error("MCP stdio closed")))
    this.child.on("error", (error) => this.fail(error))
    this.child.on("close", () => this.fail(new Error("MCP server process closed")))
    this.child.stdin.on("error", (error) => this.fail(error))
  }

  static async connect(options: EventsStdioOptions): Promise<EventsStdioClient> {
    const client = new EventsStdioClient(options)
    try {
      const result = await client.request("server/discover", {})
      if (!object(result) || result.resultType !== "complete" || !Array.isArray(result.supportedVersions)) {
        throw new Error("Invalid server/discover result")
      }
      if (!result.supportedVersions.includes(EVENTS_PROTOCOL_VERSION)) {
        throw new Error(`Server does not support MCP ${EVENTS_PROTOCOL_VERSION}`)
      }
      const capabilities = result.capabilities
      if (
        !object(capabilities) ||
        !object(capabilities.extensions) ||
        !object(capabilities.extensions[EVENTS_EXTENSION])
      ) {
        throw new Error("Server does not advertise the SEP-3415 Events extension")
      }
      client.discovered = true
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }

  private get meta(): JsonObject {
    return {
      "io.modelcontextprotocol/protocolVersion": EVENTS_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": { extensions: { [EVENTS_EXTENSION]: {} } },
      "io.modelcontextprotocol/clientInfo": { name: "mimo-events", version: "0.1.0" },
    }
  }

  private async send(message: JsonObject): Promise<void> {
    if (this.closed) throw new Error("MCP client is closed")
    const text = `${JSON.stringify(message)}\n`
    await new Promise<void>((resolve, reject) => this.child.stdin.write(text, (err) => (err ? reject(err) : resolve())))
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      void this.send({ jsonrpc: "2.0", id, method, params: { ...params, _meta: this.meta } }).catch((error) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  async listEvents(): Promise<EventDescriptor[]> {
    if (!this.discovered) throw new Error("Events extension is not negotiated")
    const results: EventDescriptor[] = []
    const seen = new Set<string>()
    let next: string | undefined
    do {
      const result = await this.request("events/list", next ? { cursor: next } : {})
      if (!object(result) || result.resultType !== "complete" || !Array.isArray(result.events)) {
        throw new Error("Invalid events/list result")
      }
      for (const event of result.events) {
        if (
          !object(event) ||
          typeof event.name !== "string" ||
          !event.name ||
          !Array.isArray(event.delivery) ||
          !event.delivery.length ||
          !event.delivery.every((v) => typeof v === "string") ||
          !object(event.inputSchema) ||
          !object(event.payloadSchema)
        )
          throw new Error("Invalid event descriptor")
        results.push({
          name: event.name,
          delivery: event.delivery,
          inputSchema: event.inputSchema,
          payloadSchema: event.payloadSchema,
          ...(typeof event.description === "string" ? { description: event.description } : {}),
        })
      }
      if (result.nextCursor !== undefined && typeof result.nextCursor !== "string")
        throw new Error("Invalid nextCursor")
      next = result.nextCursor as string | undefined
      if (next) {
        if (seen.has(next)) throw new Error("Repeated events/list cursor")
        seen.add(next)
      }
    } while (next)
    return results
  }

  openStream(
    options: { name: string; arguments?: JsonObject; cursor?: string | null; maxAgeMs?: number },
    callbacks: StreamCallbacks,
  ): EventsSubscription {
    if (!this.discovered || this.closed) throw new Error("Events extension is not connected")
    if (!options.name) throw new Error("Event name is required")
    if (options.cursor !== undefined && !cursor(options.cursor)) throw new Error("Invalid cursor")
    if (options.maxAgeMs !== undefined && (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 0))
      throw new Error("Invalid maxAgeMs")
    const id = ++this.nextId
    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    // Avoid unhandled rejection if the caller only awaits cancel/close.
    void ready.catch(() => {})
    const state: StreamState = {
      name: options.name,
      callbacks,
      active: false,
      ready,
      readyResolve,
      readyReject,
      processing: Promise.resolve(),
      pendingNotifications: 0,
      ending: false,
      timer: setTimeout(
        () => this.endStream(id, "error", new Error("events/stream activation timed out"), true),
        this.timeout,
      ),
    }
    this.streams.set(id, state)
    void this.send({
      jsonrpc: "2.0",
      id,
      method: "events/stream",
      params: {
        name: options.name,
        arguments: options.arguments ?? {},
        cursor: options.cursor ?? null,
        ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
        _meta: this.meta,
      },
    }).catch((error) => this.endStream(id, "error", error instanceof Error ? error : new Error(String(error)), false))
    return {
      id,
      ready,
      cancel: async () => {
        if (!this.streams.has(id)) return
        this.endStream(id, "cancelled", undefined, false)
        await this.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "cancelled" },
        })
      },
    }
  }

  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      this.fail(new Error("MCP stdio frame exceeds size limit"))
      return
    }
    let index: number
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this.fail(new Error("MCP stdio frame exceeds size limit"))
        return
      }
      try {
        this.handle(JSON.parse(line))
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
  }

  private handle(message: unknown): void {
    if (!object(message) || message.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC message")
    if (typeof message.method === "string" && message.id === undefined) {
      if (!message.method.startsWith("notifications/events/") || message.method === "notifications/events/list_changed")
        return
      if (!object(message.params) || !object(message.params._meta))
        throw new Error("Event notification missing subscription metadata")
      const id = message.params._meta[SUBSCRIPTION_ID]
      if (typeof id !== "string" && typeof id !== "number")
        throw new Error("Event notification missing subscription id")
      const state = this.streams.get(id)
      // Unknown IDs can be late messages after cancellation; never route them to another stream.
      if (!state) return
      this.notification(id, state, message.method, message.params)
      return
    }
    if (typeof message.id !== "number" && typeof message.id !== "string")
      throw new Error("Invalid JSON-RPC response id")
    const pending = this.pending.get(message.id)
    if (pending) {
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) pending.reject(rpcError(message.error))
      else if (message.result !== undefined) pending.resolve(message.result)
      else pending.reject(new Error("Invalid JSON-RPC response"))
      return
    }
    if (this.streams.has(message.id)) {
      if (message.error !== undefined) this.endStream(message.id, "error", rpcError(message.error), false)
      else if (
        object(message.result) &&
        message.result.resultType === "complete" &&
        object(message.result._meta) &&
        message.result._meta[SUBSCRIPTION_ID] === message.id
      ) {
        this.endStream(message.id, "ended", undefined, false)
      } else this.endStream(message.id, "error", new Error("Invalid events/stream result"), false)
    }
  }

  private enqueue(id: RpcId, state: StreamState, callback: () => void | Promise<void>): void {
    if (state.pendingNotifications >= (this.options.maxPendingNotifications ?? 100)) {
      this.endStream(id, "error", new Error("Event callback backlog exceeded"), true)
      return
    }
    state.pendingNotifications++
    state.processing = state.processing
      .then(async () => {
        if (state.ending && state.finishReason !== "ended" && state.finishReason !== "terminated") return
        await callback()
      })
      .catch((error) => this.endStream(id, "error", error instanceof Error ? error : new Error(String(error)), true))
      .finally(() => {
        state.pendingNotifications--
      })
  }

  private resetHeartbeat(id: RpcId, state: StreamState): void {
    if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer)
    state.heartbeatTimer = setTimeout(
      () => this.endStream(id, "error", new Error("MCP event stream heartbeat timed out"), true),
      this.options.heartbeatTimeoutMs ?? 65_000,
    )
  }

  private notification(id: RpcId, state: StreamState, method: string, params: JsonObject): void {
    if (state.ending) return
    if (method === "notifications/events/active") {
      if (!cursor(params.cursor) || typeof params.truncated !== "boolean") {
        this.endStream(id, "error", new Error("Invalid events/active"), true)
        return
      }
      const info = { cursor: params.cursor, truncated: params.truncated }
      if (!state.active) {
        state.active = true
        clearTimeout(state.timer)
        state.readyResolve()
      }
      this.resetHeartbeat(id, state)
      this.enqueue(id, state, () => state.callbacks.onActive?.(info))
      return
    }
    if (!state.active) {
      this.endStream(id, "error", new Error("Event received before events/active"), true)
      return
    }
    if (method === "notifications/events/event") {
      if (
        typeof params.eventId !== "string" ||
        !params.eventId ||
        params.name !== state.name ||
        typeof params.timestamp !== "string" ||
        !Number.isFinite(Date.parse(params.timestamp)) ||
        !object(params.data) ||
        (params.cursor !== undefined && !cursor(params.cursor))
      ) {
        this.endStream(id, "error", new Error("Invalid event occurrence"), true)
        return
      }
      const event: EventOccurrence = {
        eventId: params.eventId,
        name: params.name,
        timestamp: params.timestamp,
        data: params.data,
        ...(params.cursor === undefined ? {} : { cursor: params.cursor as string | null }),
      }
      this.resetHeartbeat(id, state)
      this.enqueue(id, state, () => state.callbacks.onEvent(event))
      return
    }
    if (method === "notifications/events/heartbeat") {
      if (!cursor(params.cursor)) {
        this.endStream(id, "error", new Error("Invalid events/heartbeat"), true)
        return
      }
      const value = params.cursor
      this.resetHeartbeat(id, state)
      this.enqueue(id, state, () => state.callbacks.onHeartbeat?.(value))
      return
    }
    if (method === "notifications/events/error") {
      state.callbacks.onError?.(rpcError(params.error), false)
      return
    }
    if (method === "notifications/events/terminated") {
      this.endStream(id, "terminated", rpcError(params.error), false)
      return
    }
  }

  private endStream(
    id: RpcId,
    reason: "cancelled" | "ended" | "terminated" | "error",
    error?: Error,
    cancel = false,
  ): void {
    const state = this.streams.get(id)
    if (!state || state.ending) return
    state.ending = true
    state.finishReason = reason
    this.streams.delete(id)
    clearTimeout(state.timer)
    if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer)
    if (!state.active) state.readyReject(error ?? new Error(`Stream ${reason} before activation`))
    if (cancel && !this.closed)
      void this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } }).catch(
        () => {},
      )
    void state.processing.then(() => {
      if (error) state.callbacks.onError?.(error, true)
      state.callbacks.onClose?.(reason)
    })
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
    for (const id of this.streams.keys()) this.endStream(id, "error", error)
    this.options.onError?.(error)
    this.child.stdin.destroy()
    this.child.kill()
  }

  async close(): Promise<void> {
    if (this.closed) return
    for (const id of [...this.streams.keys()]) {
      this.endStream(id, "cancelled")
      await this.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, reason: "client closed" },
      }).catch(() => {})
    }
    this.closed = true
    const error = new Error("MCP client closed")
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
    this.child.stdin.end()
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
  }
}
