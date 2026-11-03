// Projection of one session for one subscribe-session dispatch: event-text and
// event-state payloads (without the request target, which the group adds).
//
// Every frame is a full replacement. `contentRevision` is one counter shared by
// both lanes and advances only when the visible parts change; a turn's
// `finalContentRevision` names the text revision that already carries all of
// that turn's text, so the phone can tell when a finished reply is complete.
// Part and turn revisions follow the phone's progression rules: unchanged
// content keeps its revision, any change raises it, and a part that left the
// projection comes back with a revision above everything it had before.

import { clipTitle } from "./catalog"
import type { Json } from "./json"
import type { BackendSnapshot } from "./ports"

const MAX_PARTS = 256
const MAX_TURNS = 32
const MAX_TURN_IDENTITIES = 256
const MAX_PART_IDENTITIES = 8192
/** Payload budgets leave room for the request target the group adds to each frame. */
const TEXT_BUDGET_BYTES = 262_144 - 2_048
const STATE_BUDGET_BYTES = 16_384 - 2_048
const MAX_REVISION = 2 ** 31 - 1
/** The phone renders this pair as a hidden control part; it must never be produced. */
const RESERVED_MESSAGE = "mimo-remote-interaction"

export type ProjectionFrames = { text?: Record<string, Json>; state?: Record<string, Json> }
/**
 * `projection_too_large`: the session does not fit the CLI profile's single
 * snapshot. `resync_required`: this stream used up its identity budget and must
 * be restarted as a new subscription.
 */
export type ProjectionFailure = "projection_too_large" | "resync_required"

type Seen = { revision: number; body: string }

export class SessionProjection {
  readonly epoch = crypto.randomUUID()
  private contentRevision = 0
  private textSequence = -1
  private stateSequence = -1
  private partsBody: string | undefined
  private stateBody: string | undefined
  private readonly parts = new Map<string, Seen>()
  private visibleParts = new Set<string>()
  private readonly turns = new Map<string, Seen>()
  /** turnId -> the text revision at which that turn's parts last changed. */
  private readonly turnContent = new Map<string, number>()
  private previousTurnText = new Map<string, string>()

  constructor(private readonly sessionId: string) {}

  /** Frames to publish for `snapshot`, text before state; empty when nothing changed. */
  next(snapshot: BackendSnapshot): ProjectionFrames | ProjectionFailure {
    if (snapshot.turns.length > MAX_TURNS) return "projection_too_large"
    const parts = snapshot.parts.filter((part) => part.messageId !== RESERVED_MESSAGE)
    if (parts.length > MAX_PARTS) return "projection_too_large"

    const frames: ProjectionFrames = {}
    const text = this.textFrame(parts)
    if (typeof text === "string") return text
    if (text) frames.text = text
    const state = this.stateFrame(snapshot)
    if (typeof state === "string") return state
    if (state) frames.state = state
    return frames
  }

  private textFrame(parts: BackendSnapshot["parts"]): Record<string, Json> | ProjectionFailure | undefined {
    // Message order is the position among messages that have text; part order
    // is the position inside its message.
    const messageOrder = new Map<string, number>()
    const partCount = new Map<string, number>()
    const shaped = parts.map((part) => {
      if (!messageOrder.has(part.messageId)) messageOrder.set(part.messageId, messageOrder.size)
      const partOrder = partCount.get(part.messageId) ?? 0
      partCount.set(part.messageId, partOrder + 1)
      return {
        messageId: part.messageId,
        partId: part.partId,
        turnId: part.turnId,
        role: part.role,
        messageOrder: messageOrder.get(part.messageId)!,
        partOrder,
        text: part.text,
      }
    })
    const body = JSON.stringify(shaped)
    if (body === this.partsBody) return undefined
    if (this.contentRevision >= MAX_REVISION) return "resync_required"

    const visible = new Set<string>()
    const wire: Json[] = []
    let newIdentities = 0
    for (const part of shaped) {
      const key = `${part.messageId}\u0000${part.partId}`
      if (visible.has(key)) return "projection_too_large"
      visible.add(key)
      const partBody = JSON.stringify(part)
      const seen = this.parts.get(key)
      if (!seen) newIdentities += 1
      const revision = !seen ? 1 : seen.body === partBody && this.visibleParts.has(key) ? seen.revision : seen.revision + 1
      wire.push({ ...part, revision })
    }
    if (this.parts.size + newIdentities > MAX_PART_IDENTITIES) return "resync_required"

    const contentRevision = this.contentRevision + 1
    const frame = this.envelope("event-text", this.textSequence + 1, contentRevision, { parts: wire })
    if (byteLength(frame) > TEXT_BUDGET_BYTES) return "projection_too_large"

    // Commit only once the frame is known to be publishable.
    for (const [index, part] of shaped.entries()) {
      const key = `${part.messageId}\u0000${part.partId}`
      this.parts.set(key, { revision: (wire[index] as { revision: number }).revision, body: JSON.stringify(part) })
    }
    this.visibleParts = visible
    const turnText = new Map<string, string>()
    for (const part of shaped) {
      if (part.turnId === null) continue
      turnText.set(part.turnId, (turnText.get(part.turnId) ?? "") + JSON.stringify(part))
    }
    for (const [turnId, content] of turnText) {
      if (this.previousTurnText.get(turnId) !== content) this.turnContent.set(turnId, contentRevision)
    }
    this.previousTurnText = turnText
    this.partsBody = body
    this.contentRevision = contentRevision
    this.textSequence += 1
    return frame
  }

  private stateFrame(snapshot: BackendSnapshot): Record<string, Json> | ProjectionFailure | undefined {
    if (this.contentRevision === 0) return undefined
    const pending: [string, Seen][] = []
    const turns: Json[] = []
    const keys = new Set<string>()
    for (const turn of snapshot.turns) {
      const key = `${turn.inputMessageId}\u0000${turn.assistantMessageId}`
      if (keys.has(key)) return "projection_too_large"
      keys.add(key)
      const terminal = turn.phase === "completed" || turn.phase === "failed" || turn.phase === "cancelled"
      // A finished turn points at the text revision that holds all of its text;
      // a turn without text is complete with the earliest revision.
      const finalContentRevision = terminal ? (this.turnContent.get(turn.inputMessageId) ?? 1) : null
      const body = JSON.stringify([turn.phase, finalContentRevision])
      const seen = this.turns.get(key)
      const revision = !seen ? 1 : seen.body === body ? seen.revision : seen.revision + 1
      pending.push([key, { revision, body }])
      turns.push({
        inputMessageId: turn.inputMessageId,
        assistantMessageId: turn.assistantMessageId,
        phase: turn.phase,
        revision,
        finalContentRevision,
      })
    }
    const newIdentities = [...keys].filter((key) => !this.turns.has(key)).length
    if (this.turns.size + newIdentities > MAX_TURN_IDENTITIES) return "resync_required"

    const payload = { sessionPhase: snapshot.phase, turns, sessionTitle: clipTitle(snapshot.title) }
    const body = JSON.stringify(payload)
    const sequence = this.stateSequence + 1
    // A state frame is needed on the first publish and whenever phase, title or
    // a turn changed; a new text revision alone does not need one.
    if (body === this.stateBody && sequence > 0) return undefined
    const frame = this.envelope("event-state", sequence, this.contentRevision, payload)
    if (byteLength(frame) > STATE_BUDGET_BYTES) return "projection_too_large"

    for (const [key, entry] of pending) this.turns.set(key, entry)
    this.stateBody = body
    this.stateSequence = sequence
    return frame
  }

  private envelope(
    type: "event-text" | "event-state",
    sequence: number,
    contentRevision: number,
    payload: Record<string, Json>,
  ): Record<string, Json> {
    return {
      type,
      desktopSessionId: this.sessionId,
      projectionEpoch: this.epoch,
      sequence,
      snapshot: sequence === 0,
      contentRevision,
      ...payload,
    }
  }
}

function byteLength(frame: Record<string, Json>): number {
  return new TextEncoder().encode(JSON.stringify(frame)).length
}
