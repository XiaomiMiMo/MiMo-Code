// Business operations of one authorized device group, as forwarded by the
// service on the command lane: sessions-list, sessions-watch,
// subscribe-session, unsubscribe, send and submission-status.
//
// Every answer echoes the request target exactly. An operation that has not
// published anything fails with request-error; once it has, it ends with
// subscription-closed. Observations are re-read when the agent reports a change
// and published at most every 200 ms, always as full replacements.

import type { Lane } from "./api"
import { Catalog, WIRE_ID } from "./catalog"
import type { Json } from "./json"
import type { AgentBackend } from "./ports"
import { SessionProjection } from "./projection"
import type { SubmissionResult, Submissions } from "./submissions"

export const COALESCE_MS = 200
/** The phone gives every operation 30 s; answer before that with what is known. */
const SUBMIT_ANSWER_MS = 25_000

export type GroupScope = {
  bindingId: string
  deviceGroupId: string
  connectionEpoch: number
  grantVersion: number
  canSend: boolean
}

/** Sends one frame on a lane of this group; false when the lane cannot carry it. */
export type Outbox = (lane: Lane, frame: Record<string, Json>) => boolean

type Target = Record<string, Json>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class Dispatcher {
  private readonly catalog: Catalog
  private readonly observations = new Map<string, Observation>()
  private readonly unwatch: () => void
  private closed = false

  constructor(
    private readonly scope: GroupScope,
    private readonly backend: AgentBackend,
    private readonly submissions: Submissions,
    private readonly outbox: Outbox,
    private readonly clock: () => number = Date.now,
  ) {
    this.catalog = new Catalog(clock)
    this.unwatch = backend.watch((sessionId) => {
      for (const observation of this.observations.values()) observation.changed(sessionId)
    })
  }

  /** A frame received on the command lane. */
  handle(frame: Record<string, unknown>): void {
    if (this.closed) return
    if (frame.type === "subscription-closed") {
      // The service retired an observation (replaced, unsubscribed, group failure).
      if (typeof frame.dispatchId === "string") this.retire(frame.dispatchId)
      return
    }
    if (frame.type !== "request") return
    const target = this.target(frame)
    if (!target) return
    void this.dispatch(frame, target)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unwatch()
    for (const observation of this.observations.values()) observation.stop()
    this.observations.clear()
  }

  private async dispatch(frame: Record<string, unknown>, target: Target): Promise<void> {
    switch (frame.operation) {
      case "sessions-list":
        return this.list(frame, target)
      case "sessions-watch":
        return this.observe(target, new CatalogWatch(this.backend, this.catalog, target, this.reply, this.done, this.clock))
      case "subscribe-session":
        if (typeof frame.sessionId !== "string" || !WIRE_ID.test(frame.sessionId)) {
          return void this.reply(target, "request-error", { code: "not_found" })
        }
        return this.observe(
          target,
          new SessionReading(this.backend, frame.sessionId, target, this.reply, this.outbox, this.done, this.clock),
        )
      case "unsubscribe": {
        const id = frame.subscriptionRequestId
        if (typeof id !== "string") return
        for (const [dispatchId, observation] of this.observations) {
          if (observation.requestId === id) this.retire(dispatchId)
        }
        // Idempotent: the phone also unsubscribes observations that already ended.
        return void this.reply(target, "unsubscribed", { subscriptionRequestId: id })
      }
      case "send":
        return this.send(frame, target)
      case "submission-status":
        return this.status(target)
    }
  }

  private async list(frame: Record<string, unknown>, target: Target): Promise<void> {
    const limit = typeof frame.limit === "number" && Number.isInteger(frame.limit) ? Math.min(Math.max(frame.limit, 1), 50) : 50
    const cursor = typeof frame.cursor === "string" ? frame.cursor : null
    const sessions = await this.backend.listSessions().catch(() => undefined)
    if (!sessions) return void this.reply(target, "request-error", { code: "source_unavailable" })
    const page = await this.catalog.page(sessions, cursor, limit)
    if (typeof page === "string") return void this.reply(target, "request-error", { code: page })
    this.reply(target, "sessions-page", page as unknown as Record<string, Json>)
  }

  private async send(frame: Record<string, unknown>, target: Target): Promise<void> {
    if (typeof frame.text !== "string" || typeof target.sessionId !== "string") {
      return void this.reply(target, "submission-result", { status: "rejected", reason: "invalid" })
    }
    const result = this.submissions.send({
      bindingId: this.scope.bindingId,
      sessionId: target.sessionId,
      requestId: target.requestId as string,
      text: frame.text,
      canSend: this.scope.canSend,
    })
    this.reply(target, "submission-result", await answerBy(result, SUBMIT_ANSWER_MS))
  }

  private async status(target: Target): Promise<void> {
    if (typeof target.sessionId !== "string") return void this.reply(target, "submission-result", { status: "unknown" })
    const result = this.submissions.status({
      bindingId: this.scope.bindingId,
      sessionId: target.sessionId,
      requestId: target.requestId as string,
    })
    this.reply(target, "submission-result", await answerBy(result, SUBMIT_ANSWER_MS))
  }

  private observe(target: Target, observation: Observation): void {
    this.retire(target.dispatchId as string)
    this.observations.set(target.dispatchId as string, observation)
    void observation.start()
  }

  private retire(dispatchId: string): void {
    this.observations.get(dispatchId)?.stop()
    this.observations.delete(dispatchId)
  }

  private readonly done = (dispatchId: string) => {
    this.observations.delete(dispatchId)
  }

  private readonly reply = (target: Target, type: string, fields: Record<string, Json>): boolean => {
    if (this.closed) return false
    return this.outbox("command", { ...target, type, ...fields })
  }

  /** The exact target every answer must carry, or undefined for a frame outside this group. */
  private target(frame: Record<string, unknown>): Target | undefined {
    const { bindingId, deviceGroupId, connectionEpoch, grantVersion } = this.scope
    if (
      frame.protocolVersion !== 4 ||
      frame.bindingId !== bindingId ||
      frame.deviceGroupId !== deviceGroupId ||
      frame.connectionEpoch !== connectionEpoch ||
      frame.grantVersion !== grantVersion ||
      typeof frame.requestId !== "string" ||
      !UUID.test(frame.requestId) ||
      typeof frame.dispatchId !== "string" ||
      !UUID.test(frame.dispatchId)
    ) {
      return undefined
    }
    const target: Target = {
      protocolVersion: 4,
      bindingId,
      connectionEpoch,
      deviceGroupId,
      requestId: frame.requestId,
      grantVersion,
      dispatchId: frame.dispatchId,
    }
    if ("sessionId" in frame) {
      if (typeof frame.sessionId !== "string") return undefined
      target.sessionId = frame.sessionId
    }
    return target
  }
}

type Reply = (target: Target, type: string, fields: Record<string, Json>) => boolean

abstract class Observation {
  private dirty = false
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private last = Number.NEGATIVE_INFINITY
  protected started = false
  protected stopped = false

  constructor(
    protected readonly target: Target,
    protected readonly reply: Reply,
    private readonly done: (dispatchId: string) => void,
    protected readonly clock: () => number,
  ) {}

  get requestId(): string {
    return this.target.requestId as string
  }

  async start(): Promise<void> {
    await this.pump()
  }

  /** The agent reported a change (undefined = anything may have changed). */
  abstract changed(sessionId: string | undefined): void

  /** Re-read and publish; returns a failure code to end the observation with. */
  protected abstract refresh(): Promise<string | undefined>

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }

  protected kick(): void {
    if (this.stopped) return
    this.dirty = true
    if (this.running || this.timer) return
    const wait = Math.max(0, this.last + COALESCE_MS - this.clock())
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.pump()
    }, wait)
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    this.dirty = false
    this.last = this.clock()
    const failure = await this.refresh().catch(() => "source_unavailable")
    this.running = false
    if (this.stopped) return
    if (failure) return this.fail(failure)
    if (this.dirty) {
      this.dirty = false
      this.kick()
    }
  }

  protected fail(code: string): void {
    this.stop()
    this.done(this.target.dispatchId as string)
    this.reply(this.target, this.started ? "subscription-closed" : "request-error", { code })
  }
}

class CatalogWatch extends Observation {
  private revision: string | undefined

  constructor(
    private readonly backend: AgentBackend,
    private readonly catalog: Catalog,
    target: Target,
    reply: Reply,
    done: (dispatchId: string) => void,
    clock: () => number,
  ) {
    super(target, reply, done, clock)
  }

  changed(): void {
    this.kick()
  }

  protected async refresh(): Promise<string | undefined> {
    const revision = await this.catalog.revision(await this.backend.listSessions())
    if (this.stopped || revision === this.revision) return undefined
    if (!this.reply(this.target, "sessions-changed", { revision })) return undefined
    this.revision = revision
    this.started = true
    return undefined
  }
}

class SessionReading extends Observation {
  private readonly projection: SessionProjection

  constructor(
    private readonly backend: AgentBackend,
    private readonly sessionId: string,
    target: Target,
    reply: Reply,
    private readonly outbox: Outbox,
    done: (dispatchId: string) => void,
    clock: () => number,
  ) {
    super(target, reply, done, clock)
    this.projection = new SessionProjection(sessionId)
  }

  changed(sessionId: string | undefined): void {
    if (sessionId === undefined || sessionId === this.sessionId) this.kick()
  }

  protected async refresh(): Promise<string | undefined> {
    const snapshot = await this.backend.snapshot(this.sessionId)
    if (this.stopped) return undefined
    // A session that stops being listed ends the reading; the phone's re-subscribe then learns it is gone.
    if (!snapshot) return this.started ? "resync_required" : "not_found"
    const frames = this.projection.next(snapshot)
    if (typeof frames === "string") return frames
    // Text first: a state frame never names a content revision the phone has not received.
    for (const [lane, frame] of [
      ["text", frames.text],
      ["state", frames.state],
    ] as const) {
      if (!frame) continue
      if (!this.outbox(lane, { ...this.target, ...frame })) {
        // A dropped frame would be a sequence gap; restart the stream instead.
        this.started = true
        return "resync_required"
      }
      this.started = true
    }
    return undefined
  }
}

async function answerBy(result: Promise<SubmissionResult>, ms: number): Promise<Record<string, Json>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<SubmissionResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "unknown" }), ms)
  })
  // The decision keeps running; a later submission-status reads its durable outcome.
  const answer = await Promise.race([result.catch((): SubmissionResult => ({ status: "unknown" })), late])
  clearTimeout(timer)
  return answer as unknown as Record<string, Json>
}
