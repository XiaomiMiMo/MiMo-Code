import { randomUUID } from "node:crypto"
import { Context, Effect } from "effect"
import { Instance, type InstanceContext } from "@/project/instance"
import * as InstanceState from "@/effect/instance-state"
import { Database, eq, and, NotFoundError } from "@/storage"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import { ActorRegistryTable } from "@/actor/actor.sql"
import * as ExecutionState from "@/actor/execution-state"
import type { MessageV2 } from "./message-v2"
import type { SessionID } from "./schema"
import type { SessionStatus } from "./status"

export const Owner = Context.Reference<{ sessionID: string; actorID: string } | undefined>("SessionRuntime.Owner", {
  defaultValue: () => undefined,
})

export const withOwner = <A, E, R>(sessionID: string, actorID: string, work: Effect.Effect<A, E, R>) =>
  work.pipe(Effect.provideService(Owner, { sessionID, actorID }))

export type ActorState = {
  actorID: string
  status: "pending" | "running" | "idle"
  executionActive: boolean
  turnCount: number
  lastTurnTime: number
  startedAt?: number
  completedAt?: number
  lastOutcome?: string
  error?: string
}
export type RuntimeEvent = { type: string; properties: Record<string, unknown> }
export type Envelope = {
  type: "runtime.event"
  properties: {
    protocolVersion: 1
    epoch: string
    sessionID: string
    seq: number
    event: RuntimeEvent
    ownerActorId?: string
  }
}
type Base = {
  exists?: boolean
  messages: MessageV2.WithParts[]
  actors: ActorState[]
  revert: typeof SessionTable.$inferSelect.revert
}
export type ErrorOccurrence = {
  actorID: string
  id: string
  messageID?: string
  anchorMessageID?: string
  at: number
  error: NonNullable<MessageV2.Assistant["error"]>
}
type State = {
  deleted?: boolean
  seq: number
  overlay: Map<string, MessageV2.Part>
  runners: Set<string>
  execution: Map<string, { executionActive: boolean; startedAt?: number; completedAt?: number }>
  retries: Map<string, SessionStatus.RetryInfo>
  errors: Map<string, ErrorOccurrence>
}

// SQLite commits, overlay edits, sequence assignment and snapshot cloning are
// synchronous. No await or asynchronous subscriber may enter this boundary.
export class RuntimeProjection {
  readonly epoch = randomUUID()
  private sessions = new Map<string, State>()
  private listeners = new Set<(event: Envelope) => void>()

  constructor(
    private read: (sessionID: string, actorsOnly?: boolean) => Base,
    private lookup?: (sessionID: string, messageID: string, partID?: string) => { owner?: string; part?: MessageV2.Part },
    private owned: (sessionID: string) => readonly string[] = () => [],
  ) {}

  private state(sessionID: string) {
    const current = this.sessions.get(sessionID)
    if (current) return current
    const state: State = { seq: 0, overlay: new Map(), runners: new Set(), execution: new Map(), retries: new Map(), errors: new Map() }
    for (const message of this.read(sessionID).messages) {
      if (message.info.role !== "assistant" || !message.info.error) continue
      state.errors.set(`msg:${message.info.id}`, {
        actorID: message.info.agentID ?? "main", id: `msg:${message.info.id}`,
        messageID: message.info.id, at: message.info.time.completed ?? message.info.time.created,
        error: message.info.error,
      })
    }
    this.sessions.set(sessionID, state)
    return state
  }

  subscribe(listener: (event: Envelope) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private find(sessionID: string, messageID: string, partID?: string) {
    if (this.lookup) return this.lookup(sessionID, messageID, partID)
    const message = this.read(sessionID).messages.find((message) => message.info.id === messageID)
    return { owner: message ? message.info.agentID ?? "main" : undefined, part: message?.parts.find((part) => part.id === partID) }
  }

  record(sessionID: string, event: RuntimeEvent, ownerActorId?: string) {
    const state = this.state(sessionID)
    if (state.deleted && event.type !== "session.created") return
    state.deleted = event.type === "session.deleted"
    const props = event.properties
    const part = props.part as MessageV2.Part | undefined
    const info = props.info as MessageV2.Info | undefined
    const messageID = part?.messageID ?? (typeof props.messageID === "string" ? props.messageID : undefined)
    if (this.lookup && event.type === "message.updated" && info && !this.find(sessionID, info.id).owner) return
    if (this.lookup && event.type === "message.part.updated" && part && !this.find(sessionID, part.messageID, part.id).part) return
    const owner = ownerActorId ?? (event.type === "message.updated" && info ? info.agentID ?? "main" : messageID ? this.find(sessionID, messageID).owner : undefined)
    if (event.type === "message.updated" && info?.role === "assistant") {
      const id = `msg:${info.id}`
      if (!info.error) state.errors.delete(id)
      else if (!state.errors.has(id)) state.errors.set(id, {
        actorID: owner!, id, messageID: info.id,
        at: info.time.completed ?? info.time.created, error: info.error,
      })
    }
    if (event.type === "message.removed" && messageID) state.errors.delete(`msg:${messageID}`)
    if (event.type === "session.error" && owner && props.error) {
      const errorID = typeof props.messageID === "string" ? `msg:${props.messageID}` : `event:${state.seq + 1}`
      const existing = state.errors.get(errorID)
      const anchorMessageID = typeof props.anchorMessageID === "string" ? props.anchorMessageID
        : this.read(sessionID).messages.filter((message) => (message.info.agentID ?? "main") === owner).at(-1)?.info.id
      const occurrence: ErrorOccurrence = existing ?? {
        actorID: owner, id: errorID,
        ...(typeof props.messageID === "string" ? { messageID: props.messageID } : anchorMessageID ? { anchorMessageID } : {}),
        at: Date.now(), error: props.error as ErrorOccurrence["error"],
      }
      state.errors.set(errorID, occurrence)
      event = { ...event, properties: { ...props, id: occurrence.id, at: occurrence.at,
        ...(occurrence.messageID ? { messageID: occurrence.messageID } : {}),
        ...(occurrence.anchorMessageID ? { anchorMessageID: occurrence.anchorMessageID } : {}),
      } }
    }
    if (event.type === "message.part.delta") {
      const id = props.partID as string
      const current = state.overlay.get(id) ?? this.find(sessionID, messageID!, id).part
      if (!current) return
      const next = (state.overlay.has(id) ? current : structuredClone(current)) as MessageV2.Part & Record<string, unknown>
      const field = props.field as string
      if (typeof next[field] !== "string") return
      next[field] += props.delta as string
      state.overlay.set(id, next)
    }
    if (event.type === "message.part.updated" && part) state.overlay.delete(part.id)
    if (event.type === "message.part.removed") state.overlay.delete(props.partID as string)
    if (event.type === "message.removed") {
      for (const [id, part] of state.overlay) if (part.messageID === messageID) state.overlay.delete(id)
    }
    if (event.type === "session.deleted") {
      state.overlay.clear()
      state.runners.clear()
      state.execution.clear()
      state.retries.clear()
      state.errors.clear()
    }
    const envelope: Envelope = {
      type: "runtime.event",
      properties: { protocolVersion: 1, epoch: this.epoch, sessionID, seq: ++state.seq, event: structuredClone(event), ...(owner ? { ownerActorId: owner } : {}) },
    }
    for (const listener of this.listeners) listener(envelope)
    return envelope
  }

  retry(sessionID: string, actorID: string, status: SessionStatus.RetryInfo | null) {
    const state = this.state(sessionID)
    if (state.deleted) return
    if (status) state.retries.set(actorID, structuredClone(status))
    else state.retries.delete(actorID)
    return this.record(sessionID, { type: "actor.retry", properties: { sessionID, actorID, status } }, actorID)
  }

  clearRetry(sessionID: string, actorID: string) {
    if (this.state(sessionID).retries.has(actorID)) this.retry(sessionID, actorID, null)
  }

  private clearErrors(sessionID: string, actorID: string) {
    const errors = this.state(sessionID).errors
    for (const occurrence of [...errors.values()].filter((entry) => entry.actorID === actorID)) {
      if (errors.get(occurrence.id) !== occurrence) continue
      errors.delete(occurrence.id)
      this.record(sessionID, { type: "actor.error.clear", properties: { sessionID, actorID, id: occurrence.id } }, actorID)
    }
  }

  execution(sessionID: string, actorID: string, executionActive: boolean) {
    const state = this.state(sessionID)
    if (state.deleted) return
    this.clearRetry(sessionID, actorID)
    if (executionActive) this.clearErrors(sessionID, actorID)
    if (executionActive) state.runners.add(actorID)
    else state.runners.delete(actorID)
    return this.refreshExecution(sessionID, actorID)
  }

  refreshExecution(sessionID: string, actorID: string) {
    const state = this.state(sessionID)
    if (state.deleted) return
    const executionActive = state.runners.has(actorID) || this.owned(sessionID).includes(actorID)
    const previous = state.execution.get(actorID)
    if (previous?.executionActive !== executionActive) {
      this.clearRetry(sessionID, actorID)
      if (executionActive && !state.runners.has(actorID)) this.clearErrors(sessionID, actorID)
      state.execution.set(actorID, {
        executionActive,
        startedAt: executionActive ? Date.now() : previous?.startedAt,
        ...(!executionActive ? { completedAt: Date.now() } : {}),
      })
    }
    return this.actor(sessionID, actorID)
  }

  actor(sessionID: string, actorID: string) {
    const base = this.read(sessionID, true)
    if (base.exists === false) return
    const actor = this.actors(sessionID, base.actors).find((actor) => actor.actorID === actorID)
    if (!actor) return
    return this.record(sessionID, { type: "actor.runtime", properties: { sessionID, actor } }, actorID)
  }

  private actors(sessionID: string, actors: ActorState[]) {
    const state = this.state(sessionID)
    const execution = state.execution
    const owned = new Set(this.owned(sessionID))
    const ids = new Set([...actors.map((actor) => actor.actorID), ...execution.keys(), ...owned, ...[...state.errors.values()].map((error) => error.actorID)])
    return [...ids].map((actorID) => {
      const base = actors.find((actor) => actor.actorID === actorID) ?? { actorID, status: "idle" as const, executionActive: false, turnCount: 0, lastTurnTime: 0 }
      const live = execution.get(actorID)
      const executionActive = state.runners.has(actorID) || owned.has(actorID)
      const error = [...state.errors.values()].filter((entry) => entry.actorID === actorID).at(-1)
      const data = error?.error.data
      const message = data && "message" in data && typeof data.message === "string" ? data.message : undefined
      return { ...base, ...live, executionActive,
        ...(error ? { error: message ?? error.error.name } : {}),
        status: executionActive ? "running" as const : "idle" as const,
      }
    })
  }

  prepareImport(sessionID: string, replacedMessageIDs: readonly string[] = []) {
    if (!this.sessions.has(sessionID)) return
    const before = this.read(sessionID)
    const replaced = new Set(replacedMessageIDs)
    return () => {
      const after = this.read(sessionID)
      this.state(sessionID).deleted = false
      const old = new Map(before.messages.map((message) => [message.info.id, message]))
      const next = new Set(after.messages.map((message) => message.info.id))
      for (const message of before.messages) {
        if (!next.has(message.info.id)) this.record(sessionID, { type: "message.removed", properties: { sessionID, messageID: message.info.id } }, message.info.agentID ?? "main")
      }
      for (const message of after.messages) {
        const previous = old.get(message.info.id)
        if (JSON.stringify(previous?.info) !== JSON.stringify(message.info)) {
          this.record(sessionID, { type: "message.updated", properties: { sessionID, info: message.info } })
        }
        const parts = new Map(previous?.parts.map((part) => [part.id, part]) ?? [])
        const ids = new Set(message.parts.map((part) => part.id))
        for (const part of parts.values()) {
          if (!ids.has(part.id)) this.record(sessionID, { type: "message.part.removed", properties: { sessionID, messageID: message.info.id, partID: part.id } }, message.info.agentID ?? "main")
        }
        for (const part of message.parts) {
          if (replaced.has(message.info.id) || JSON.stringify(parts.get(part.id)) !== JSON.stringify(part)) {
            this.record(sessionID, { type: "message.part.updated", properties: { sessionID, part } })
          }
        }
      }
    }
  }

  snapshot(sessionID: string) {
    const state = this.state(sessionID)
    const base = this.read(sessionID)
    if (base.exists === false) throw new NotFoundError({ message: `Session not found: ${sessionID}` })
    const messages = base.messages.map((message) => ({
      info: message.info,
      parts: message.parts.map((part) => state.overlay.get(part.id) ?? part),
    }))
    return structuredClone({
      protocolVersion: 1 as const,
      epoch: this.epoch,
      sessionID,
      throughSeq: state.seq,
      scope: { agentID: "*" as const, messageIDs: messages.map((message) => message.info.id), revert: base.revert },
      messages,
      actors: this.actors(sessionID, base.actors),
      retries: [...state.retries].map(([actorID, status]) => ({ actorID, status })),
      errors: [...state.errors.values()],
    })
  }
}

const instances = new WeakMap<InstanceContext, RuntimeProjection>()
const active = new Set<WeakRef<RuntimeProjection>>()

// Importers write SQLite directly, sometimes without an Instance context. Capture
// their before/after images inside the same transaction, without retaining instances.
export function observeImport(sessionID: string, replacedMessageIDs: readonly string[] = []) {
  const commits: (() => void)[] = []
  for (const ref of active) {
    const runtime = ref.deref()
    if (!runtime) { active.delete(ref); continue }
    const commit = runtime.prepareImport(sessionID, replacedMessageIDs)
    if (commit) commits.push(commit)
  }
  Database.effect(() => { for (const commit of commits) commit() })
}
export function current() {
  return InstanceState.bind(() => {
    const context = Instance.current
    const existing = instances.get(context)
    if (existing) return existing
    const executions = ExecutionState.current()
    const runtime = new RuntimeProjection(
      (id, actorsOnly) => Database.transaction((db) => {
        const sessionID = id as SessionID
        const session = db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
        if (!session) return { exists: false, messages: [], actors: [], revert: null }
        const parts = new Map<string, MessageV2.Part[]>()
        if (!actorsOnly) {
          for (const row of db.select().from(PartTable).where(eq(PartTable.session_id, sessionID)).orderBy(PartTable.id).all()) {
            const group = parts.get(row.message_id) ?? []
            group.push({ ...row.data, id: row.id, sessionID, messageID: row.message_id } as MessageV2.Part)
            parts.set(row.message_id, group)
          }
        }
        return {
          revert: session.revert,
          messages: actorsOnly ? [] : db.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID)).orderBy(MessageTable.time_created, MessageTable.id).all().map((row) => ({
            info: { ...row.data, id: row.id, sessionID, agentID: row.agent_id } as MessageV2.Info,
            parts: parts.get(row.id) ?? [],
          })),
          actors: db.select().from(ActorRegistryTable).where(eq(ActorRegistryTable.session_id, sessionID)).all().map((row) => ({
            actorID: row.actor_id, status: row.status, executionActive: false,
            turnCount: row.turn_count, lastTurnTime: row.last_turn_time,
            ...(row.last_outcome ? { lastOutcome: row.last_outcome } : {}),
            ...(row.last_error ? { error: row.last_error } : {}),
          })),
        }
      }),
      (id, messageID, partID) => Database.use((db) => {
        const message = db.select().from(MessageTable).where(and(eq(MessageTable.session_id, id as SessionID), eq(MessageTable.id, messageID as typeof MessageTable.$inferSelect.id))).get()
        const part = partID ? db.select().from(PartTable).where(and(eq(PartTable.session_id, id as SessionID), eq(PartTable.id, partID as typeof PartTable.$inferSelect.id))).get() : undefined
        return { owner: message?.agent_id, part: part ? { ...part.data, id: part.id, sessionID: part.session_id, messageID: part.message_id } as MessageV2.Part : undefined }
      }),
      (sessionID) => [...executions.values()].filter((execution) => execution.sessionID === sessionID).map((execution) => execution.actorID),
    )
    instances.set(context, runtime)
    active.add(new WeakRef(runtime))
    return runtime
  })()
}

export * as SessionRuntime from "./runtime"
