// Control channel (`/api/connect/control`, mimo-connect-control-v1-cli-v1).
//
// The control socket is the CLI's online lease. The service assigns a new
// connectionEpoch on every attach; every mutating HTTP call, grant and channel
// token is bound to the current epoch, so a closed control socket ends the whole
// connection generation. The CLI only echoes the epoch, it never invents one.
//
// Liveness is the service heartbeat (R60): the service configures the socket,
// probes it and confirms each answer only after renewing the lease. The lease is
// counted conservatively from when the confirmed probe was first answered; a
// lease that ran out without a confirmation ends the generation.

import type { ConnectHttp } from "./http"
import { HEARTBEAT_HEADER, HEARTBEAT_MODE, type HeartbeatMember, type HeartbeatRuntime } from "./heartbeat"
import { CLOSE_POLICY, HandshakeRejected, wssUrl, type Dial, type FrameSocket } from "./socket"

export const CONTROL_PATH = "/api/connect/control"
export const CONTROL_PROTOCOL = "mimo-connect-control-v1-cli-v1"
const READY_TIMEOUT_MS = 10_000
const LEASE_CHECK_MS = 1_000
/** The service closes a control socket on any inbound frame above this. */
export const CONTROL_MAX_FRAME = 1024

export type ControlEvents = {
  /** The generation ended: socket closed, heartbeat or lease lost, or the service rejected a frame. */
  onClosed(reason: string): void
}

export class ControlChannel {
  private socket: FrameSocket | undefined
  private heartbeat: HeartbeatMember | undefined
  private leaseTimer: ReturnType<typeof setInterval> | undefined
  /** Local monotonic time the online lease runs out unless a confirmation renews it. */
  private leaseUntil = 0
  private leaseMs = 0
  private closed = false
  epoch = 0

  constructor(
    private readonly http: ConnectHttp,
    private readonly origin: () => string,
    private readonly dial: Dial,
    private readonly heartbeats: HeartbeatRuntime,
    private readonly events: ControlEvents,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Open the socket and resolve with the epoch from `ready`. */
  async open(): Promise<number> {
    const headers = await this.http.handshakeHeaders(CONTROL_PATH, { [HEARTBEAT_HEADER]: HEARTBEAT_MODE })
    let resolveReady!: (epoch: number) => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<number>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Observed even when open gives up before awaiting it (closed while dialing).
    ready.catch(() => undefined)
    // Registered before dialing: frames that arrive with the 101 are heartbeat frames already.
    this.heartbeat = this.heartbeats.register({
      send: (frame) => this.socket?.send(frame),
      expired: (reason) => this.fail(reason, rejectReady),
      confirmed: (pongAt) => {
        this.leaseUntil = Math.max(this.leaseUntil, pongAt + this.leaseMs)
      },
    })
    try {
      this.socket = await this.dial({
        url: wssUrl(this.origin(), CONTROL_PATH),
        headers,
        protocol: CONTROL_PROTOCOL,
        echo: ["Mimo-Request-Id", HEARTBEAT_HEADER],
        maxFrameBytes: CONTROL_MAX_FRAME,
        handlers: {
          onFrame: (frame) => this.frame(frame, resolveReady, rejectReady),
          onClose: (code, reason) => this.end(`closed:${code}:${reason}`, rejectReady),
        },
      })
    } catch (error) {
      this.heartbeat.remove()
      if (error instanceof HandshakeRejected) this.http.noteRetryAfter(error.status, error.retryAfter)
      throw error
    }
    // Closed while dialing: an orphan socket would take a new epoch from the live generation.
    if (this.closed) {
      this.socket.close(1000, "closed_by_client")
      throw new Error("closed_by_client")
    }
    const timeout = setTimeout(() => this.fail("ready_timeout", rejectReady), READY_TIMEOUT_MS)
    try {
      const epoch = await ready
      if (this.closed) throw new Error("closed_by_client")
      this.leaseTimer = setInterval(() => {
        if (this.now() >= this.leaseUntil) this.fail("lease_expired")
      }, LEASE_CHECK_MS)
      this.leaseTimer.unref?.()
      return epoch
    } finally {
      clearTimeout(timeout)
    }
  }

  close(): void {
    this.end("closed_by_client")
    this.socket?.close(1000, "closed_by_client")
  }

  private frame(
    frame: Record<string, unknown>,
    resolveReady: (epoch: number) => void,
    rejectReady: (error: Error) => void,
  ): void {
    const heartbeat = this.heartbeat!
    try {
      if (heartbeat.consume(frame)) return
    } catch {
      return this.fail("invalid_heartbeat", rejectReady)
    }
    heartbeat.inbound()
    // The service configures the heartbeat before it publishes ready; nothing else ever follows.
    if (this.epoch !== 0 || !heartbeat.configured) return this.fail("unexpected_frame", rejectReady)
    const ready = readyFrame(frame)
    if (!ready) return this.fail("invalid_ready", rejectReady)
    this.epoch = ready.epoch
    this.leaseMs = ready.leaseMs
    // The service granted the lease when it published ready.
    this.leaseUntil = this.now() + ready.leaseMs
    resolveReady(ready.epoch)
  }

  private fail(reason: string, reject?: (error: Error) => void): void {
    // Record the real reason first: the runtime may fire the close event synchronously.
    this.end(reason, reject)
    this.socket?.close(CLOSE_POLICY, reason)
  }

  private end(reason: string, reject?: (error: Error) => void): void {
    // A pending open always settles, also when the channel was already closed by the client.
    reject?.(new Error(reason))
    if (this.closed) return
    this.closed = true
    clearInterval(this.leaseTimer)
    this.heartbeat?.remove()
    this.events.onClosed(reason)
  }
}

function readyFrame(frame: Record<string, unknown>): { epoch: number; leaseMs: number } | undefined {
  const keys = Object.keys(frame).sort().join(",")
  if (keys !== "connectionEpoch,connectorLeaseMs,heartbeatMs,protocolVersion,type") return undefined
  if (frame.type !== "ready" || frame.protocolVersion !== 1) return undefined
  if (frame.heartbeatMs !== 25000 || frame.connectorLeaseMs !== 75000) return undefined
  const epoch = frame.connectionEpoch
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) return undefined
  return { epoch, leaseMs: frame.connectorLeaseMs }
}
