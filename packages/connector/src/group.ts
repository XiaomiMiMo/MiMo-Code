// One authorized device group of a binding on the bus (bus-channel §4.3–§4.6):
// one bus connection under one grant, the cmd subscription and the dispatcher
// that answers each request on its reply channel.
//
// Order: connect, subscribe `cmd:{bindingId}`, then register the group, so no
// command published for this group can arrive before the subscription. The
// registration lives 75 s and is renewed every 25 s. Any publish failure,
// withdrawn subscription or lost connection ends the group; the runtime then
// rebuilds with a new deviceGroupId and the phone re-reads from a snapshot.
// Business commands are never re-sent.

import type { ConnectApi, GrantView, Lane } from "./api"
import { BusSocket, type BusDiagnostic, type BusEvents } from "./bus"
import { Dispatcher } from "./dispatcher"
import { ConnectError, type ConnectHttp } from "./http"
import { withinDepth, type Json } from "./json"
import type { AgentBackend } from "./ports"
import type { Dial } from "./socket"
import type { Submissions } from "./submissions"

const RENEW_MS = 25_000
/** A failed renewal is retried this soon; the registration itself lives 75 s. */
const RENEW_RETRY_MS = 5_000
/** Give up on the group before its registration could have lapsed unnoticed. */
const REGISTRATION_MS = 70_000
/** The service withdrew the subscription because the binding or grant is no longer authorized. */
const UNSUBSCRIBE_REVOKED = 2001
/** Local backpressure limit, including the publication awaiting its ACK. */
const MAX_PENDING_REPLIES = 16

/** Business frame nesting ceiling (connect-protocol R63). */
const BUSINESS_FRAME_MAX_DEPTH = 16

export type GroupDiagnostic = BusDiagnostic | "unknown_lane"

export type GroupContext = {
  api: ConnectApi
  http: ConnectHttp
  origin: () => string
  dial: Dial
  backend: AgentBackend
  submissions: Submissions
  clock?: () => number
  /** Monotonic time for liveness and renewal; defaults to performance.now. */
  now?: () => number
  /** Fixed-category R63 diagnostic, reported at most once per category per group. */
  onIgnored?(category: GroupDiagnostic): void
}

export type GroupGrant = Pick<GrantView, "bindingId" | "grantVersion" | "connectionEpoch" | "scopes">

export type GroupEnd = {
  reason: string
  /** The service reported the binding or grant revoked. */
  revoked: boolean
  /** A verified protocol version refusal is terminal, not a lost bus. */
  incompatible?: boolean
}

type PendingReply = {
  channel: string
  data: { lane: Lane; frame: Record<string, Json> }
  signal?: AbortSignal
  resolve(acknowledged: boolean): void
}

export class DeviceGroup {
  readonly deviceGroupId = crypto.randomUUID()
  private readonly opening = new AbortController()
  private readonly replies: PendingReply[] = []
  private bus: BusSocket | undefined
  private dispatcher: Dispatcher | undefined
  private renewTimer: ReturnType<typeof setTimeout> | undefined
  private registeredAt = 0
  private ended = false
  private readonly ignored = new Set<GroupDiagnostic>()
  /** Registered and subscribed: the group serves the phone. */
  ready = false

  constructor(
    private readonly context: GroupContext,
    readonly grant: GroupGrant,
    private readonly onEnded: (end: GroupEnd) => void,
  ) {}

  private get now(): () => number {
    return this.context.now ?? (() => performance.now())
  }

  private get cmd(): string {
    return `cmd:${this.grant.bindingId}`
  }

  /** Connect, subscribe and register; resolves once the group serves the phone. */
  async open(): Promise<void> {
    if (this.ended) throw new Error("closed_by_client")
    const canSend = (this.grant.scopes as string[]).includes("sessions:send")
    this.dispatcher = new Dispatcher(
      {
        bindingId: this.grant.bindingId,
        deviceGroupId: this.deviceGroupId,
        connectionEpoch: this.grant.connectionEpoch,
        grantVersion: this.grant.grantVersion,
        canSend,
      },
      this.context.backend,
      this.context.submissions,
      (lane, frame, signal) => this.reply(lane, frame, signal),
      this.context.clock,
    )
    const events: BusEvents = {
      publication: (channel, data) => this.publication(channel, data),
      unsubscribed: (channel, code) => {
        if (channel === this.cmd) this.end({ reason: `unsubscribed_${code}`, revoked: code === UNSUBSCRIBE_REVOKED })
      },
      closed: (reason) => this.end({ reason, revoked: false }),
      ignored: (category) => this.noteIgnored(category),
    }
    try {
      const bus = await BusSocket.open(
        this.context.http,
        this.context.origin(),
        this.context.dial,
        events,
        this.now,
        this.opening.signal,
      )
      if (this.ended) {
        bus.close()
        throw new Error("closed_by_client")
      }
      this.bus = bus
      await bus.subscribe(this.cmd)
      if (this.ended) throw new Error("closed_by_client")
      await this.register()
      if (this.ended) throw new Error("closed_by_client")
      this.ready = true
      this.scheduleRenew(RENEW_MS)
    } catch (error) {
      const revoked = error instanceof ConnectError && error.code === "binding_revoked"
      this.end({ reason: error instanceof Error ? error.message : "open_failed", revoked }, false)
      throw error
    }
  }

  close(): void {
    this.end({ reason: "closed_by_client", revoked: false }, false)
  }

  private async register(): Promise<void> {
    await this.context.api.busRegistration(this.grant.bindingId, {
      deviceGroupId: this.deviceGroupId,
      grantVersion: this.grant.grantVersion,
      connectionEpoch: this.grant.connectionEpoch,
    })
    this.registeredAt = this.now()
  }

  private scheduleRenew(wait: number): void {
    clearTimeout(this.renewTimer)
    if (this.ended) return
    this.renewTimer = setTimeout(() => void this.renew(), wait)
  }

  private async renew(): Promise<void> {
    if (this.ended) return
    try {
      await this.register()
      this.scheduleRenew(RENEW_MS)
    } catch (error) {
      if (this.ended) return
      const transient = error instanceof ConnectError && error.transient
      if (transient && this.now() - this.registeredAt + RENEW_RETRY_MS < REGISTRATION_MS) {
        return this.scheduleRenew(Math.max(RENEW_RETRY_MS, error.retryAfterMs ?? 0))
      }
      // A changed epoch or grant, a revoked binding or a lapsed registration: rebuild.
      const code = error instanceof ConnectError ? error.code : "registration_failed"
      this.end({
        reason: `registration_${code}`,
        revoked: code === "binding_revoked",
        incompatible: code === "protocol_incompatible",
      })
    }
  }

  private publication(channel: string, data: Record<string, unknown>): void {
    if (channel !== this.cmd || this.ended) return
    const lane = data.lane
    const frame = data.frame
    if (typeof lane !== "string" || lane.length === 0 || typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return this.end({ reason: "invalid_command", revoked: false })
    }
    if (lane !== "command") {
      // Unregistered publication lane on the CLI cmd channel (R63): drop without ending the group.
      this.noteIgnored("unknown_lane")
      return
    }
    if (!withinDepth(frame, BUSINESS_FRAME_MAX_DEPTH)) {
      this.noteIgnored("too_deep")
      return
    }
    this.dispatcher?.handle(frame as Record<string, unknown>)
  }

  private noteIgnored(category: GroupDiagnostic): void {
    if (this.ignored.has(category)) return
    this.ignored.add(category)
    this.context.onIgnored?.(category)
  }

  /** Queue one answer on its request's reply channel; never carry it into another group. */
  private reply(lane: Lane, frame: Record<string, Json>, signal?: AbortSignal): Promise<boolean> {
    const bus = this.bus
    const requestId = frame.requestId
    if (this.ended || !bus || signal?.aborted || typeof requestId !== "string") return Promise.resolve(false)
    if (this.replies.length >= MAX_PENDING_REPLIES) {
      // Dropping one reply and leaving the group live would leave a gap.
      this.end({ reason: "publish_queue_full", revoked: false })
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      this.replies.push({ channel: `rep:${this.grant.bindingId}:${requestId}`, data: { lane, frame }, signal, resolve })
      if (this.replies.length === 1) void this.flushReplies(bus)
    })
  }

  private async flushReplies(bus: BusSocket): Promise<void> {
    while (!this.ended) {
      const next = this.replies[0]
      if (!next) return
      if (!next.signal?.aborted) {
        try {
          await bus.publish(next.channel, next.data)
        } catch (error) {
          this.end({ reason: error instanceof Error ? `publish_${error.message}` : "publish_failed", revoked: false })
          return
        }
        if (this.ended) return
      }
      this.replies.shift()
      next.resolve(!next.signal?.aborted)
    }
  }

  private end(end: GroupEnd, notify = true): void {
    if (this.ended) return
    this.ended = true
    this.ready = false
    clearTimeout(this.renewTimer)
    this.dispatcher?.close()
    this.dispatcher = undefined
    for (const reply of this.replies.splice(0)) reply.resolve(false)
    this.opening.abort()
    this.bus?.close()
    this.bus = undefined
    if (notify) this.onEnded(end)
  }
}
