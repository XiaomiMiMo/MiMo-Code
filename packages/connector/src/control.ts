// Control channel (`/api/connect/control`, mimo-connect-control-v1-cli-v1).
//
// The control socket is the CLI's online lease. The service assigns a new
// connectionEpoch on every attach; every mutating HTTP call, grant and channel
// token is bound to the current epoch, so a closed control socket ends the whole
// connection generation. The CLI only echoes the epoch, it never invents one.

import type { ConnectHttp } from "./http"
import { CLOSE_POLICY, wssUrl, type Dial, type FrameSocket } from "./socket"

export const CONTROL_PATH = "/api/connect/control"
export const CONTROL_PROTOCOL = "mimo-connect-control-v1-cli-v1"
/** Service heartbeat interval is 25 s with a 75 s lease; stay well inside it. */
const HEARTBEAT_MS = 20_000
const READY_TIMEOUT_MS = 10_000
const PONG_TIMEOUT_MS = 10_000

export type ControlEvents = {
  /** The generation ended: socket closed, heartbeat lost or the service rejected a frame. */
  onClosed(reason: string): void
}

export class ControlChannel {
  private socket: FrameSocket | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private awaitingPong: ReturnType<typeof setTimeout> | undefined
  private closed = false
  epoch = 0

  constructor(
    private readonly http: ConnectHttp,
    private readonly origin: () => string,
    private readonly dial: Dial,
    private readonly events: ControlEvents,
  ) {}

  /** Open the socket and resolve with the epoch from `ready`. */
  async open(): Promise<number> {
    const headers = await this.http.handshakeHeaders(CONTROL_PATH)
    let resolveReady!: (epoch: number) => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<number>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Observed even when open gives up before awaiting it (closed while dialing).
    ready.catch(() => undefined)
    this.socket = await this.dial({
      url: wssUrl(this.origin(), CONTROL_PATH),
      headers,
      protocol: CONTROL_PROTOCOL,
      maxFrameBytes: 4096,
      handlers: {
        onFrame: (frame) => {
          if (this.epoch === 0) {
            const epoch = readyEpoch(frame)
            if (epoch === undefined) return this.fail("invalid_ready", rejectReady)
            this.epoch = epoch
            resolveReady(epoch)
            return
          }
          if (frame.type === "pong" && frame.protocolVersion === 1 && frame.connectionEpoch === this.epoch) {
            clearTimeout(this.awaitingPong)
            this.awaitingPong = undefined
            return
          }
          this.fail("unexpected_frame", rejectReady)
        },
        onClose: (code, reason) => this.end(`closed:${code}:${reason}`, rejectReady),
      },
    })
    // Closed while dialing: an orphan socket would take a new epoch from the live generation.
    if (this.closed) {
      this.socket.close(1000, "closed_by_client")
      throw new Error("closed_by_client")
    }
    const timeout = setTimeout(() => this.fail("ready_timeout", rejectReady), READY_TIMEOUT_MS)
    try {
      const epoch = await ready
      if (this.closed) throw new Error("closed_by_client")
      this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
      return epoch
    } finally {
      clearTimeout(timeout)
    }
  }

  close(): void {
    this.end("closed_by_client")
    this.socket?.close(1000, "closed_by_client")
  }

  private heartbeat(): void {
    if (this.closed || this.awaitingPong) return
    this.socket?.send({ protocolVersion: 1, type: "heartbeat" })
    this.awaitingPong = setTimeout(() => this.fail("pong_timeout"), PONG_TIMEOUT_MS)
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
    clearInterval(this.timer)
    clearTimeout(this.awaitingPong)
    this.events.onClosed(reason)
  }
}

function readyEpoch(frame: Record<string, unknown>): number | undefined {
  const keys = Object.keys(frame).sort().join(",")
  if (keys !== "connectionEpoch,connectorLeaseMs,heartbeatMs,protocolVersion,type") return undefined
  if (frame.type !== "ready" || frame.protocolVersion !== 1) return undefined
  if (frame.heartbeatMs !== 25000 || frame.connectorLeaseMs !== 75000) return undefined
  const epoch = frame.connectionEpoch
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 1 ? epoch : undefined
}
