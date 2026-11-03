// Phone text submissions into the original session.
//
// A phone request is identified by (binding, session, requestId). Its message ID
// is chosen once and made durable BEFORE the agent sees the text, so a crash,
// a lost reply or a repeated send can only ever resolve to that same message:
// the agent is idempotent on message ID and lookups are read-only. Nothing is
// re-sent on a status query.

import { hex, sha256 } from "./json"
import type { AgentBackend } from "./ports"
import type { StateFile } from "./state"

export type SubmissionResult =
  | { status: "accepted"; messageId: string }
  | { status: "rejected"; reason: "read-only" | "busy" | "invalid" | "offline" }
  | { status: "unknown" }

export type SendRequest = {
  bindingId: string
  sessionId: string
  requestId: string
  text: string
  canSend: boolean
}

export class Submissions {
  /** One in-flight decision per request key: concurrent repeats share it instead of racing. */
  private readonly inflight = new Map<string, Promise<SubmissionResult>>()

  constructor(
    private readonly backend: AgentBackend,
    private readonly state: StateFile,
    private readonly clock: () => number = Date.now,
  ) {}

  send(request: SendRequest): Promise<SubmissionResult> {
    if (!request.canSend) return Promise.resolve({ status: "rejected", reason: "read-only" })
    const key = keyOf(request)
    // A concurrent repeat waits for the first decision, then re-checks against the
    // durable record (same text resolves to the same message, other text is rejected).
    const running = this.inflight.get(key)
    if (running) return running.catch(() => undefined).then(() => this.send(request))
    const result = this.decide(key, request).finally(() => this.inflight.delete(key))
    this.inflight.set(key, result)
    return result
  }

  private async decide(key: string, request: SendRequest): Promise<SubmissionResult> {
    const textSha256 = hex(await sha256(request.text))
    const existing = (await this.state.read()).submissions[key]
    if (existing) {
      // Same request ID with other text is a different request: never run it.
      if (existing.textSha256 !== textSha256) return { status: "rejected", reason: "invalid" }
      return this.resolve(request.sessionId, existing.messageId)
    }
    if (!(await this.backend.listSessions()).some((session) => session.id === request.sessionId)) {
      return { status: "rejected", reason: "invalid" }
    }
    const messageId = this.backend.newMessageId()
    await this.state.update((state) => {
      state.submissions[key] = { messageId, textSha256, createdAt: this.clock() }
    })
    const outcome = await this.backend.submit(request.sessionId, messageId, request.text).catch(() => ({ kind: "unknown" as const }))
    if (outcome.kind === "accepted") return { status: "accepted", messageId }
    if (outcome.kind === "rejected") return { status: "rejected", reason: outcome.reason }
    return this.resolve(request.sessionId, messageId)
  }

  /** submission-status: read-only, keyed by the original send's request ID. */
  async status(request: Omit<SendRequest, "text" | "canSend">): Promise<SubmissionResult> {
    const existing = (await this.state.read()).submissions[keyOf(request)]
    // No record: this installation never handed that request to the agent, or
    // the record expired. Neither proves non-admission to the phone.
    if (!existing) return { status: "unknown" }
    return this.resolve(request.sessionId, existing.messageId)
  }

  private async resolve(sessionId: string, messageId: string): Promise<SubmissionResult> {
    const found = await this.backend.lookup(sessionId, messageId).catch(() => ({ kind: "unknown" as const }))
    return found.kind === "admitted" ? { status: "accepted", messageId } : { status: "unknown" }
  }
}

function keyOf(request: { bindingId: string; sessionId: string; requestId: string }): string {
  return `${request.bindingId}:${request.sessionId}:${request.requestId}`
}
