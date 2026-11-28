// Bus connection (`/api/connect/bus`, mimo-connect-bus-v1-cli), bus-channel §4.5.
//
// A JSON subset of the Centrifuge client protocol: commands carry an `id` and get
// a reply with the same id; pushes carry publications, unsubscribes and
// disconnects; an empty object is the service ping, answered with an empty
// command. Liveness is that ping alone (no service heartbeat headers): the
// connection is dead once nothing arrived for ping + 20 s.

import type { ConnectHttp } from "./http"
import { withinDepth } from "./json"
import { CLOSE_POLICY, HandshakeRejected, wssUrl, type Dial, type FrameSocket } from "./socket"

export const BUS_PATH = "/api/connect/bus"
export const BUS_PROTOCOL = "mimo-connect-bus-v1-cli"
/** One bus message: a 256 KiB lane frame plus the publication envelope and Centrifuge framing. */
export const BUS_MESSAGE_BYTES = 262144 + 1024 + 4096
/** Largest publication `data` the service accepts (bus-channel §4.5). */
export const BUS_PUBLICATION_BYTES = 262144 + 1024
/** Bus message nesting ceiling for CLI (connect-protocol R63: outer 4 + inner frame 16). */
export const BUS_MESSAGE_MAX_DEPTH = 20
const PING_GRACE_MS = 20_000
const REPLY_MS = 10_000
const MAX_PING_SECONDS = 60

export type BusDiagnostic = "unknown_push" | "too_deep"

export type BusEvents = {
  publication(channel: string, data: Record<string, unknown>): void
  /** The service withdrew a subscription (2001 revoked authority, 2501 temporary). */
  unsubscribed(channel: string, code: number): void
  /** The connection ended; every pending command failed with the same reason. */
  closed(reason: string): void
  /** Fixed-category R63 diagnostic, reported at most once per category per connection. */
  ignored?(category: BusDiagnostic): void
}

export class BusCommandError extends Error {
  constructor(
    readonly code: number,
    readonly temporary: boolean,
  ) {
    super(`bus error ${code}`)
    this.name = "BusCommandError"
  }
}

export class BusSocket {
  private socket: FrameSocket | undefined
  private nextId = 1
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>()
  private lastInbound = 0
  private pingMs = 25_000
  private silenceTimer: ReturnType<typeof setInterval> | undefined
  private ended = false
  private readonly ignored = new Set<BusDiagnostic>()

  private constructor(
    private readonly events: BusEvents,
    private readonly now: () => number,
  ) {}

  /** Upgrade, then `connect`; resolves once the service accepted the connection. */
  static async open(
    http: ConnectHttp,
    origin: string,
    dial: Dial,
    events: BusEvents,
    now: () => number = () => performance.now(),
    signal?: AbortSignal,
  ): Promise<BusSocket> {
    const bus = new BusSocket(events, now)
    const close = () => bus.close()
    if (signal?.aborted) throw new Error("closed_by_client")
    signal?.addEventListener("abort", close, { once: true })
    try {
      await bus.connect(http, origin, dial)
      if (bus.ended) throw new Error("bus_closed")
      return bus
    } finally {
      signal?.removeEventListener("abort", close)
    }
  }

  private async connect(http: ConnectHttp, origin: string, dial: Dial): Promise<void> {
    const headers = await http.handshakeHeaders(BUS_PATH, {})
    if (this.ended) throw new Error("bus_closed")
    let socket: FrameSocket
    try {
      socket = await dial({
        url: wssUrl(origin, BUS_PATH),
        headers,
        protocol: BUS_PROTOCOL,
        echo: ["Mimo-Request-Id"],
        maxFrameBytes: BUS_MESSAGE_BYTES,
        lines: true,
        handlers: {
          onFrame: (frame) => this.receive(frame),
          onClose: (code, reason) => this.end(reason || `close_${code}`),
        },
      })
    } catch (error) {
      if (error instanceof HandshakeRejected) http.noteRetryAfter(error.status, error.retryAfter)
      throw error
    }
    // Dial itself cannot be cancelled. A late socket never becomes this bus's transport.
    if (this.ended) {
      socket.close(1000, "bus_closed")
      throw new Error("bus_closed")
    }
    this.socket = socket
    this.lastInbound = this.now()
    this.silenceTimer = setInterval(() => {
      if (this.now() - this.lastInbound > this.pingMs + PING_GRACE_MS) this.fail("ping_timeout")
    }, 1_000)
    try {
      const reply = await this.command("connect", {})
      const connect = reply.connect as Record<string, unknown> | undefined
      const ping = connect?.ping
      if (
        typeof connect !== "object" ||
        typeof connect.client !== "string" ||
        typeof ping !== "number" ||
        !Number.isInteger(ping) ||
        ping < 1 ||
        ping > MAX_PING_SECONDS ||
        connect.pong !== true
      ) {
        throw new Error("invalid_connect")
      }
      this.pingMs = ping * 1000
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "connect_failed")
      throw error
    }
  }

  async subscribe(channel: string): Promise<void> {
    const reply = await this.command("subscribe", { channel })
    if (typeof reply.subscribe !== "object" || reply.subscribe === null) throw new Error("invalid_subscribe")
  }

  /** Resolves once the service acknowledged the publication; rejects with its refusal. */
  async publish(channel: string, data: Record<string, unknown>): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(data)) > BUS_PUBLICATION_BYTES) throw new BusCommandError(106, false)
    const { publish } = await this.command("publish", { channel, data })
    if (typeof publish !== "object" || publish === null || Array.isArray(publish)) throw new Error("invalid_publish")
  }

  close(): void {
    this.end("closed_by_client", 1000)
  }

  private command(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.ended || !this.socket) return Promise.reject(new Error("bus_closed"))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("bus_reply_timeout"))
        this.fail("bus_reply_timeout")
      }, REPLY_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          const error = value.error as Record<string, unknown> | undefined
          if (error !== undefined) {
            if (typeof error !== "object" || error === null || typeof error.code !== "number") {
              return reject(new Error("invalid_error"))
            }
            return reject(new BusCommandError(error.code, error.temporary === true))
          }
          resolve(value)
        },
        reject: (reason) => {
          clearTimeout(timer)
          reject(reason)
        },
      })
      this.socket!.send({ id, [method]: params })
    })
  }

  private receive(frame: Record<string, unknown>): void {
    if (this.ended) return
    if (!withinDepth(frame, BUS_MESSAGE_MAX_DEPTH)) {
      this.noteIgnored("too_deep")
      return
    }
    const keys = Object.keys(frame)
    if (keys.length === 0) {
      this.lastInbound = this.now()
      // The service ping; connect declared pong, so answer with an empty command.
      this.socket?.send({})
      return
    }
    if ("id" in frame) {
      this.lastInbound = this.now()
      const id = frame.id
      if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return this.fail("invalid_reply")
      this.pending.get(id)?.resolve(frame)
      this.pending.delete(id)
      return
    }
    const push = frame.push as Record<string, unknown> | undefined
    if (typeof push !== "object" || push === null || Array.isArray(push)) return this.fail("invalid_push")
    const disconnect = push.disconnect as Record<string, unknown> | undefined
    if (disconnect !== undefined) {
      this.lastInbound = this.now()
      const reason = typeof disconnect?.reason === "string" ? disconnect.reason : "disconnect"
      return this.fail(reason === "unauthorized" ? "unauthorized" : `disconnect_${String(disconnect?.code)}`)
    }
    if ("pub" in push) {
      this.lastInbound = this.now()
      const channel = push.channel
      const pub = push.pub as Record<string, unknown> | undefined
      const data = pub?.data
      if (
        typeof channel !== "string" ||
        typeof pub !== "object" ||
        pub === null ||
        typeof pub.offset !== "number" ||
        typeof data !== "object" ||
        data === null ||
        Array.isArray(data)
      ) {
        return this.fail("invalid_publication")
      }
      this.events.publication(channel, data as Record<string, unknown>)
      return
    }
    if ("unsubscribe" in push) {
      this.lastInbound = this.now()
      const channel = push.channel
      const unsubscribe = push.unsubscribe as Record<string, unknown> | undefined
      if (typeof channel !== "string" || typeof unsubscribe !== "object" || unsubscribe === null || typeof unsubscribe.code !== "number") {
        return this.fail("invalid_push")
      }
      this.events.unsubscribed(channel, unsubscribe.code)
      return
    }
    // Unregistered bus push kind (R63): drop this push, keep the bus open.
    this.noteIgnored("unknown_push")
  }

  private noteIgnored(category: BusDiagnostic): void {
    if (this.ignored.has(category)) return
    this.ignored.add(category)
    this.events.ignored?.(category)
  }

  private fail(reason: string): void {
    this.end(reason, CLOSE_POLICY)
  }

  private end(reason: string, closeCode?: number): void {
    if (this.ended) return
    this.ended = true
    const socket = this.socket
    this.socket = undefined
    clearInterval(this.silenceTimer)
    const error = new Error(reason)
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
    if (closeCode != null) socket?.close(closeCode, reason)
    this.events.closed(reason)
  }
}
