// MiMo Code as the phone connector's agent: the sessions of the current
// project, their conversation and turn outcomes, and submissions through the
// engine's own idempotent prompt path.
//
// Everything goes through the same server API the TUI uses, so the phone sees
// exactly what the local session list shows and a phone message is admitted
// exactly like a typed one. Turn outcomes come from the engine's durable
// prompt receipts, never from timing.

import type {
  AgentBackend,
  BackendPart,
  BackendSession,
  BackendSnapshot,
  BackendTurn,
  LookupOutcome,
  SubmitOutcome,
} from "@mimo-ai/connector"
import type { Event, Message, Session, SessionStatus } from "@mimo-ai/sdk/v2"
import { MessageID, PartID } from "@/session/schema"
import { SessionMirror, type ConversationEvent, type MessageWithParts } from "./mirror"

/** Same window the TUI session list loads. */
const LIST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** The engine returns at most this many messages without paging; more cannot be shown whole. */
export const MESSAGE_LIMIT = 1000
const MIRROR_IDLE_MS = 60_000
const MAX_MIRRORS = 8
/** The engine's prompt limit is shared with the person typing; the phone takes a small share. */
const SUBMITS_PER_MINUTE = 6
/** A turn beyond this many cannot be shown anyway (the phone takes at most 32 turns). */
const RECEIPT_TURNS = 32
const RECEIPT_CONCURRENCY = 4
/** Unfinished receipts follow events; a read is only repeated after this long. */
const RECEIPT_RECHECK_MS = 10_000
const RECEIPT_ABSENT_RECHECK_MS = 30_000

export type Receipt = {
  state: "accepted" | "claimed" | "settled" | "cancelled" | "rejected"
  outcome?: "success" | "assistant_error" | "interrupted" | "never_ran"
}

/** The slice of the server API the backend uses; `fromClient` adapts the SDK client. */
export interface EngineApi {
  /** Root sessions of the current project updated in the window, as the TUI list loads them. */
  listSessions(since: number): Promise<Session[]>
  /** The main conversation, oldest first; `complete` is false when the engine cut it off. */
  messages(sessionId: string): Promise<{ messages: MessageWithParts[]; complete: boolean }>
  status(): Promise<Record<string, SessionStatus>>
  /** The prompt receipt for a user message: undefined when none exists, throws when unknown. */
  receipt(sessionId: string, messageId: string): Promise<Receipt | undefined>
  /** Returns the HTTP status of prompt_async. */
  promptAsync(input: {
    sessionID: string
    messageID: string
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
    parts: { id: string; type: "text"; text: string }[]
  }): Promise<number>
}

export type EngineEvents = {
  on<Type extends Event["type"]>(type: Type, handler: (event: Extract<Event, { type: Type }>) => void): () => void
}

const CONVERSATION_EVENTS = [
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.delta",
  "message.part.removed",
  "session.compacted",
] as const

export class MimoBackend implements AgentBackend {
  private sessions: Promise<Session[]> | undefined
  private statuses: Record<string, SessionStatus> | undefined
  private statusLoad: Promise<Record<string, SessionStatus>> | undefined
  /** Status events seen before the status map was read; they are newer than or equal to what it returns. */
  private readonly earlyStatuses = new Map<string, SessionStatus>()
  private readonly mirrors = new Map<string, { mirror: SessionMirror; usedAt: number }>()
  /** Receipts by user message ID; terminal ones never change again. */
  private readonly receipts = new Map<string, Receipt>()
  /** When each prompt's receipt was last read, so unfinished or missing ones are not re-read on every frame. */
  private readonly receiptReadAt = new Map<string, number>()
  private readonly listeners = new Set<(sessionId: string | undefined) => void>()
  private readonly submitted: number[] = []
  private readonly unsubscribe: (() => void)[] = []

  constructor(
    private readonly api: EngineApi,
    events: EngineEvents,
    private readonly clock: () => number = Date.now,
  ) {
    for (const type of CONVERSATION_EVENTS) {
      this.unsubscribe.push(
        events.on(type, (event) => {
          const sessionId = event.properties.sessionID
          this.mirrors.get(sessionId)?.mirror.apply(event as ConversationEvent)
          this.notify(sessionId)
        }),
      )
    }
    for (const type of ["session.created", "session.updated", "session.deleted"] as const) {
      this.unsubscribe.push(
        events.on(type, () => {
          this.sessions = undefined
          this.notify(undefined)
        }),
      )
    }
    this.unsubscribe.push(
      events.on("session.status", (event) => {
        const { sessionID, status } = event.properties
        if (this.statuses) this.statuses[sessionID] = status
        else this.earlyStatuses.set(sessionID, status)
        this.notify(sessionID)
      }),
      events.on("session.receipt.updated", (event) => {
        const { agentID, inputMessageID, state, outcome } = event.properties
        if (agentID !== "main") return
        this.receipts.set(inputMessageID, { state, outcome })
        this.notify(event.properties.sessionID)
      }),
    )
  }

  dispose(): void {
    for (const off of this.unsubscribe) off()
    this.listeners.clear()
  }

  async listSessions(): Promise<BackendSession[]> {
    return (await this.listed())
      .filter((session) => session.parentID === undefined)
      .toSorted((a, b) => {
        // The TUI session list order: by day of last update, then newest first.
        const day = startOfDay(b.time.updated) - startOfDay(a.time.updated)
        return day !== 0 ? day : b.time.created - a.time.created
      })
      .map((session) => ({ id: session.id, title: session.title, updatedAt: session.time.updated }))
  }

  async snapshot(sessionId: string): Promise<BackendSnapshot | undefined> {
    if (!(await this.listSessions()).some((session) => session.id === sessionId)) return undefined
    const mirror = this.mirror(sessionId)
    await mirror.ready()
    await this.loadReceipts(sessionId, turnInputs(mirror.conversation()))
    const statuses = await this.statusMap()
    const session = (await this.listed()).find((entry) => entry.id === sessionId)
    // Cut the snapshot only now, with no await after it: events apply in order, so a
    // finished receipt is never paired with text older than what it finished with.
    const conversation = mirror.conversation()
    return {
      title: session?.title ?? "",
      phase: phaseOf(statuses[sessionId]),
      parts: partsOf(conversation),
      turns: this.turnsOf(conversation),
      ...(mirror.truncated ? { complete: false } : {}),
    }
  }

  watch(onChange: (sessionId: string | undefined) => void): () => void {
    this.listeners.add(onChange)
    return () => this.listeners.delete(onChange)
  }

  newMessageId(): string {
    return MessageID.ascending()
  }

  async submit(sessionId: string, messageId: string, text: string): Promise<SubmitOutcome> {
    const now = this.clock()
    while (this.submitted.length > 0 && now - this.submitted[0] >= 60_000) this.submitted.shift()
    if (this.submitted.length >= SUBMITS_PER_MINUTE) return { kind: "rejected", reason: "busy" }
    this.submitted.push(now)
    // Continue the session as it was being used: same agent and model as its last prompt.
    const mirror = this.mirror(sessionId)
    await mirror.ready().catch(() => undefined)
    const last = mirror.conversation().findLast((entry) => entry.info.role === "user")?.info as
      | Extract<Message, { role: "user" }>
      | undefined
    const status = await this.api
      .promptAsync({
        sessionID: sessionId,
        messageID: messageId,
        ...(last
          ? {
              agent: last.agent,
              model: { providerID: last.model.providerID, modelID: last.model.modelID },
              ...(last.model.variant ? { variant: last.model.variant } : {}),
            }
          : {}),
        parts: [{ id: PartID.ascending(), type: "text", text }],
      })
      .catch(() => undefined)
    if (status === 202) return { kind: "accepted" }
    // Validation and rate limiting answer before anything is written.
    if (status === 400 || status === 404) return { kind: "rejected", reason: "invalid" }
    if (status === 429) return { kind: "rejected", reason: "busy" }
    return { kind: "unknown" }
  }

  async lookup(sessionId: string, messageId: string): Promise<LookupOutcome> {
    try {
      const receipt = await this.api.receipt(sessionId, messageId)
      if (!receipt) return { kind: "absent" }
      this.receipts.set(messageId, receipt)
      return { kind: "admitted" }
    } catch {
      return { kind: "unknown" }
    }
  }

  private listed(): Promise<Session[]> {
    const pending = (this.sessions ??= this.api.listSessions(this.clock() - LIST_WINDOW_MS))
    pending.catch(() => {
      if (this.sessions === pending) this.sessions = undefined
    })
    return pending
  }

  private mirror(sessionId: string): SessionMirror {
    const now = this.clock()
    const existing = this.mirrors.get(sessionId)
    if (existing) {
      existing.usedAt = now
      return existing.mirror
    }
    // Only sessions a phone is reading are mirrored; idle ones are dropped.
    for (const [id, entry] of this.mirrors) {
      if (now - entry.usedAt > MIRROR_IDLE_MS || this.mirrors.size >= MAX_MIRRORS) this.mirrors.delete(id)
    }
    const mirror = new SessionMirror(sessionId, (id) => this.api.messages(id))
    this.mirrors.set(sessionId, { mirror, usedAt: now })
    return mirror
  }

  private async statusMap(): Promise<Record<string, SessionStatus>> {
    if (this.statuses) return this.statuses
    this.statusLoad ??= this.api.status().then(
      (fetched) => {
        this.statuses = { ...fetched, ...Object.fromEntries(this.earlyStatuses) }
        this.earlyStatuses.clear()
        return this.statuses
      },
      (error: unknown) => {
        this.statusLoad = undefined
        throw error
      },
    )
    return this.statusLoad
  }

  private async loadReceipts(sessionId: string, inputs: string[]): Promise<void> {
    const now = this.clock()
    const due = inputs.slice(-RECEIPT_TURNS).filter((id) => {
      const receipt = this.receipts.get(id)
      if (isTerminal(receipt)) return false
      const readAt = this.receiptReadAt.get(id)
      if (readAt === undefined) return true
      return now - readAt >= (receipt ? RECEIPT_RECHECK_MS : RECEIPT_ABSENT_RECHECK_MS)
    })
    for (let start = 0; start < due.length; start += RECEIPT_CONCURRENCY) {
      await Promise.all(
        due.slice(start, start + RECEIPT_CONCURRENCY).map(async (messageId) => {
          const receipt = await this.api.receipt(sessionId, messageId).catch(() => null)
          // A read that failed is retried next time; a missing receipt is remembered for a while.
          if (receipt === null) return
          this.receiptReadAt.set(messageId, now)
          // A receipt event may already be newer than this read.
          if (receipt && !isTerminal(this.receipts.get(messageId))) this.receipts.set(messageId, receipt)
        }),
      )
    }
  }

  private turnsOf(conversation: MessageWithParts[]): BackendTurn[] {
    // A prompt's reply is its last assistant message with visible text (the phone
    // matches outcomes to the last text it shows), or its last one when none has text.
    const replies = new Map<string, { id: string; text: boolean }>()
    for (const { info, parts } of conversation) {
      if (info.role !== "assistant" || info.summary) continue
      const text = parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored)
      const current = replies.get(info.parentID)
      if (!current || text || !current.text) replies.set(info.parentID, { id: info.id, text })
    }
    return turnInputs(conversation).flatMap((inputMessageId) => {
      const assistantMessageId = replies.get(inputMessageId)?.id
      if (!assistantMessageId) return []
      return [{ inputMessageId, assistantMessageId, phase: turnPhase(this.receipts.get(inputMessageId)) }]
    })
  }

  private notify(sessionId: string | undefined): void {
    for (const listener of this.listeners) listener(sessionId)
  }
}

/** The user prompts of a conversation: compaction and checkpoint triggers are not turns. */
function turnInputs(conversation: MessageWithParts[]): string[] {
  return conversation
    .filter(
      ({ info, parts }) =>
        info.role === "user" && !parts.some((part) => part.type === "compaction" || part.type === "checkpoint"),
    )
    .map(({ info }) => info.id)
}

function partsOf(conversation: MessageWithParts[]): BackendPart[] {
  const prompts = new Set(turnInputs(conversation))
  const parts: BackendPart[] = []
  for (const { info, parts: messageParts } of conversation) {
    if (info.role === "assistant" && info.summary) continue
    if (info.role === "user" && !prompts.has(info.id)) continue
    for (const part of messageParts) {
      if (part.type !== "text" || part.synthetic || part.ignored) continue
      parts.push({
        messageId: info.id,
        partId: part.id,
        role: info.role,
        turnId: info.role === "user" ? info.id : info.parentID,
        text: part.text,
      })
    }
  }
  return parts
}

function isTerminal(receipt: Receipt | undefined): boolean {
  return receipt?.state === "settled" || receipt?.state === "cancelled" || receipt?.state === "rejected"
}

function turnPhase(receipt: Receipt | undefined): BackendTurn["phase"] {
  switch (receipt?.state) {
    case "accepted":
    case "claimed":
      return "running"
    case "settled":
      return receipt.outcome === "success" ? "completed" : receipt.outcome === "assistant_error" ? "failed" : "unknown"
    case "cancelled":
      return "cancelled"
    default:
      return "unknown"
  }
}

function phaseOf(status: SessionStatus | undefined): BackendSnapshot["phase"] {
  // Idle sessions are absent from the status map.
  if (!status || status.type === "idle") return "idle"
  if (status.type === "retry") return "retry"
  return "running"
}

function startOfDay(time: number): number {
  return new Date(time).setHours(0, 0, 0, 0)
}
