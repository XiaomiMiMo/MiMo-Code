// One content lane (`/api/connect/content-relay/{command,state,text}`,
// mimo-connect-content-v1-cli-v1).
//
// Order on every lane: attach -> fence -> (gate persisted) -> fence-ack ->
// heartbeat-ready -> transport-ready. The service re-fences a live lane whenever the binding or
// grant changes; until the new fence is acknowledged the lane carries no
// business traffic. A revoked fence ends with fence-confirmed and a close.

import type { ChannelCredential, Lane } from "./api"
import type { ConnectHttp } from "./http"
import { HEARTBEAT_HEADER, HEARTBEAT_MODE, type HeartbeatMember, type HeartbeatRuntime } from "./heartbeat"
import { CLOSE_POLICY, HandshakeRejected, wssUrl, type Dial, type FrameSocket } from "./socket"

export const CONTENT_PROTOCOL = "mimo-connect-content-v1-cli-v1"
/** The service closes a lane whose fence is not acknowledged within 5 s. */
const GATE_BUDGET_MS = 4_000
const MAX_INBOUND: Record<Lane, number> = { command: 262144, state: 16384, text: 262144 }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type Fence = {
  fenceId: string
  bindingId: string
  deviceGroupId: string
  grantVersion: number
  revocationVersion: number
  connectionEpoch: number
  state: "active" | "revoked"
  grantState: "active" | "revoked"
}

export type LaneEvents = {
  /**
   * Persist the fence and close admission for anything it no longer allows.
   * Resolving means the gate is durable; the lane then acknowledges the fence.
   */
  onFence(lane: Lane, fence: Fence): Promise<void>
  /** Business frames (requests on command; nothing is expected on state/text). */
  onFrame(lane: Lane, frame: Record<string, unknown>): void
  onClosed(lane: Lane, reason: string): void
}

export class ContentLane {
  private socket: FrameSocket | undefined
  private heartbeat: HeartbeatMember | undefined
  private closed = false
  ready = false
  revoked = false

  constructor(
    readonly lane: Lane,
    private readonly credential: ChannelCredential,
    private readonly http: ConnectHttp,
    private readonly origin: () => string,
    private readonly dial: Dial,
    private readonly heartbeats: HeartbeatRuntime,
    private readonly events: LaneEvents,
  ) {}

  /** Resolves on the first transport-ready; rejects if the lane closes first. */
  async open(): Promise<void> {
    const path = `/api/connect/content-relay/${this.lane}`
    const headers = await this.http.handshakeHeaders(path, { [HEARTBEAT_HEADER]: HEARTBEAT_MODE })
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Observed even when open gives up before awaiting it (closed while dialing).
    ready.catch(() => undefined)
    let relayError: string | undefined
    // Registered before dialing: the service configures the heartbeat right after attach.
    const heartbeat = (this.heartbeat = this.heartbeats.register({
      send: (frame) => this.socket?.send(frame),
      expired: (reason) => this.fail(reason),
    }))
    try {
      this.socket = await this.dial({
        url: wssUrl(this.origin(), path),
        headers,
        protocol: CONTENT_PROTOCOL,
        echo: ["Mimo-Request-Id", HEARTBEAT_HEADER],
        maxFrameBytes: MAX_INBOUND[this.lane],
        handlers: {
          onFrame: (frame) => {
            try {
              if (heartbeat.consume(frame)) return
            } catch {
              return this.fail("invalid_heartbeat")
            }
            heartbeat.inbound()
            switch (frame.type) {
              case "fence":
                return void this.fence(frame)
              case "transport-ready":
                // The service configures the heartbeat before the lane is ready.
                if (!heartbeat.configured || !this.matches(frame)) return this.fail("transport_ready_mismatch")
                this.ready = true
                return resolveReady()
              case "fence-confirmed":
                this.revoked = true
                this.ready = false
                return
              case "relay-error":
                relayError = typeof frame.error === "string" ? frame.error : "relay_error"
                this.ready = false
                return
              default:
                if (!this.ready) return this.fail("frame_before_ready")
                this.events.onFrame(this.lane, frame)
            }
          },
          onClose: (code, reason) => {
            const why = relayError ?? (reason || `close_${code}`)
            rejectReady(new Error(why))
            this.end(why)
          },
        },
      })
    } catch (error) {
      heartbeat.remove()
      if (error instanceof HandshakeRejected) this.http.noteRetryAfter(error.status, error.retryAfter)
      throw error
    }
    // Closed while dialing: nothing may be attached for a group that already ended.
    if (this.closed) {
      this.socket.close(1000, "closed_by_client")
      throw new Error("closed_by_client")
    }
    this.socket.send({
      protocolVersion: 1,
      type: "attach",
      bindingId: this.credential.bindingId,
      targetKind: "cli",
      deviceGroupId: this.credential.deviceGroupId,
      lane: this.lane,
      grantVersion: this.credential.grantVersion,
      connectionEpoch: this.credential.connectionEpoch,
      token: this.credential.token,
    })
    await ready
  }

  send(frame: Record<string, unknown>): boolean {
    if (!this.ready || this.closed) return false
    this.socket?.send(frame)
    return true
  }

  close(): void {
    this.end("closed_by_client")
    this.socket?.close(1000, "closed_by_client")
  }

  private async fence(frame: Record<string, unknown>): Promise<void> {
    this.ready = false
    const fence = parseFence(frame)
    if (!fence || !this.matches(frame)) return this.fail("invalid_fence")
    const deadline = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), GATE_BUDGET_MS))
    // Never acknowledge a fence whose gate is not durable: a late or failed gate closes the lane.
    const outcome = await Promise.race([
      this.events.onFence(this.lane, fence).then(() => "ok" as const),
      deadline,
    ]).catch(() => "failed" as const)
    if (outcome !== "ok") return this.fail(`gate_${outcome}`)
    if (this.closed) return
    this.socket?.send({
      protocolVersion: 1,
      type: "fence-ack",
      fenceId: fence.fenceId,
      bindingId: fence.bindingId,
      deviceGroupId: fence.deviceGroupId,
      grantVersion: fence.grantVersion,
      revocationVersion: fence.revocationVersion,
      connectionEpoch: fence.connectionEpoch,
    })
  }

  private matches(frame: Record<string, unknown>): boolean {
    return (
      frame.protocolVersion === 1 &&
      frame.bindingId === this.credential.bindingId &&
      frame.targetKind === "cli" &&
      frame.deviceGroupId === this.credential.deviceGroupId &&
      frame.connectionEpoch === this.credential.connectionEpoch
    )
  }

  private fail(reason: string): void {
    // Record the real reason first: the runtime may fire the close event synchronously.
    this.end(reason)
    this.socket?.close(CLOSE_POLICY, reason)
  }

  private end(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.ready = false
    this.heartbeat?.remove()
    this.events.onClosed(this.lane, reason)
  }
}

const FENCE_KEYS = [
  "bindingId",
  "connectionEpoch",
  "deviceGroupId",
  "fenceId",
  "grantState",
  "grantVersion",
  "protocolVersion",
  "revocationVersion",
  "state",
  "targetKind",
  "type",
].join(",")

function parseFence(frame: Record<string, unknown>): Fence | undefined {
  if (Object.keys(frame).sort().join(",") !== FENCE_KEYS) return undefined
  const ints = [frame.grantVersion, frame.revocationVersion, frame.connectionEpoch]
  if (!ints.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return undefined
  if (typeof frame.fenceId !== "string" || !UUID.test(frame.fenceId)) return undefined
  if (frame.state !== "active" && frame.state !== "revoked") return undefined
  if (frame.grantState !== "active" && frame.grantState !== "revoked") return undefined
  return {
    fenceId: frame.fenceId,
    bindingId: frame.bindingId as string,
    deviceGroupId: frame.deviceGroupId as string,
    grantVersion: frame.grantVersion as number,
    revocationVersion: frame.revocationVersion as number,
    connectionEpoch: frame.connectionEpoch as number,
    state: frame.state,
    grantState: frame.grantState,
  }
}
