import z from "zod"
import { Database, eq, NotFoundError } from "@/storage"
import { SyncEvent } from "@/sync"
import { MessageID, SessionID } from "@/session/schema"
import { MessageTable, SessionTable } from "@/session/session.sql"
import { InboxLaneStateTable, InboxSessionEpochTable, InboxTable } from "./inbox.sql"

export class QueueValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QueueValidationError"
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new QueueValidationError(result.error.message)
  return result.data
}

export const ReceiptRowSchema = z.object({
  id: z.string().min(1),
  receiver_session_id: SessionID.zod,
  receiver_actor_id: z.string(),
  sender_session_id: SessionID.zod.nullable(),
  sender_actor_id: z.string().nullable(),
  type: z.string(),
  content: z.object({ text: z.string().optional() }).nullable(),
  input_message_id: MessageID.zod.nullable(),
  state: z.enum(["accepted", "claimed", "settled", "cancelled", "rejected"]),
  epoch: z.number().int().nonnegative(),
  run_id: z.number().int().nullable(),
  claim_frontier: MessageID.zod.nullable(),
  consumed: z.boolean(),
  outcome: z.enum(["success", "assistant_error", "interrupted", "never_ran"]).nullable(),
  delivery_message_id: MessageID.zod.nullable(),
  error: z.string().nullable(),
  idempotency_key: z.string(),
  created_at: z.number().int(),
  time_updated: z.number().int(),
})

export const LaneRowSchema = z.object({
  session_id: SessionID.zod,
  agent_id: z.string(),
  consumed_frontier: MessageID.zod.nullable(),
  input_revision: z.number().int().nonnegative(),
  time_updated: z.number().int(),
})

export const EpochRowSchema = z.object({
  session_id: SessionID.zod,
  epoch: z.number().int().nonnegative(),
  time_updated: z.number().int(),
})

export const DeltaSchema = z.object({
  sessionID: SessionID.zod,
  receipts: ReceiptRowSchema.array().optional(),
  deletedReceiptIDs: z.string().min(1).array().optional(),
  lanes: LaneRowSchema.array().optional(),
  epoch: EpochRowSchema.optional(),
})
export type Delta = {
  sessionID: SessionID
  receipts?: Array<typeof InboxTable.$inferSelect>
  deletedReceiptIDs?: string[]
  lanes?: Array<typeof InboxLaneStateTable.$inferSelect>
  epoch?: typeof InboxSessionEpochTable.$inferSelect
}

export const SnapshotSchema = z.object({
  version: z.literal(1),
  sessionID: SessionID.zod,
  receipts: ReceiptRowSchema.array(),
  lanes: LaneRowSchema.array(),
  epoch: EpochRowSchema.nullable(),
})
export type Snapshot = z.infer<typeof SnapshotSchema>

export const Event = {
  Delta: SyncEvent.define({ type: "session.inbox.delta", version: 1, aggregate: "sessionID", schema: DeltaSchema }),
  Snapshot: SyncEvent.define({ type: "session.inbox.snapshot", version: 1, aggregate: "sessionID", schema: SnapshotSchema }),
}

function validate(db: Database.TxOrDb, data: Delta | Snapshot) {
  if (!db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, data.sessionID)).get())
    throw new NotFoundError({ message: `Session not found: ${data.sessionID}` })
  if (data.receipts?.some((row) => row.receiver_session_id !== data.sessionID))
    throw new QueueValidationError("Inbox row belongs to another session")
  if (data.lanes?.some((row) => row.session_id !== data.sessionID))
    throw new QueueValidationError("Inbox row belongs to another session")
  if (data.epoch && data.epoch.session_id !== data.sessionID)
    throw new QueueValidationError("Inbox row belongs to another session")
  if (new Set(data.receipts?.map((row) => row.id)).size !== (data.receipts?.length ?? 0)) throw new QueueValidationError("Duplicate inbox ID")
  if (new Set(data.lanes?.map((row) => row.agent_id)).size !== (data.lanes?.length ?? 0)) throw new QueueValidationError("Duplicate inbox lane")
  const deleted = "deletedReceiptIDs" in data ? data.deletedReceiptIDs ?? [] : []
  for (const id of new Set([...(data.receipts ?? []).map((row) => row.id), ...deleted])) {
    const current = db.select({ sessionID: InboxTable.receiver_session_id }).from(InboxTable)
      .where(eq(InboxTable.id, id)).get()
    if (current && current.sessionID !== data.sessionID) throw new QueueValidationError(`Inbox row belongs to another session: ${id}`)
  }
  const references = new Set<MessageID>()
  for (const row of data.lanes ?? []) if (row.consumed_frontier) references.add(row.consumed_frontier)
  for (const row of data.receipts ?? []) {
    if (row.input_message_id) references.add(row.input_message_id)
    if (row.delivery_message_id) references.add(row.delivery_message_id)
    if (row.claim_frontier) references.add(row.claim_frontier)
  }
  for (const id of references) {
    const message = db.select({ sessionID: MessageTable.session_id, agentID: MessageTable.agent_id }).from(MessageTable).where(eq(MessageTable.id, id)).get()
    if (message && message.sessionID !== data.sessionID) throw new QueueValidationError(`Inbox message belongs to another session: ${id}`)
  }
  for (const row of data.receipts ?? []) {
    if (!row.input_message_id) continue
    const message = db.select({ agentID: MessageTable.agent_id }).from(MessageTable).where(eq(MessageTable.id, row.input_message_id)).get()
    if (message && message.agentID !== row.receiver_actor_id) throw new QueueValidationError(`Inbox message belongs to another lane: ${row.input_message_id}`)
  }
}

function apply(db: Database.TxOrDb, data: Delta | Snapshot) {
  for (const row of data.receipts ?? [])
    db.insert(InboxTable).values(row).onConflictDoUpdate({ target: InboxTable.id, set: row }).run()
  for (const row of data.lanes ?? [])
    db.insert(InboxLaneStateTable).values(row).onConflictDoUpdate({ target: [InboxLaneStateTable.session_id, InboxLaneStateTable.agent_id], set: row }).run()
  if (data.epoch)
    db.insert(InboxSessionEpochTable).values(data.epoch).onConflictDoUpdate({ target: InboxSessionEpochTable.session_id, set: data.epoch }).run()
}

export const projectors = [
  SyncEvent.project(Event.Delta, (db, value) => {
    const data = parse(DeltaSchema, value)
    validate(db, data)
    for (const id of data.deletedReceiptIDs ?? []) db.delete(InboxTable).where(eq(InboxTable.id, id)).run()
    apply(db, data)
  }),
  SyncEvent.project(Event.Snapshot, (db, data) => applySnapshot(data, db)),
]

export function applySnapshot(value: Snapshot, db: Database.TxOrDb): void {
  const data = parse(SnapshotSchema, value)
  validate(db, data)
  db.delete(InboxTable).where(eq(InboxTable.receiver_session_id, data.sessionID)).run()
  db.delete(InboxLaneStateTable).where(eq(InboxLaneStateTable.session_id, data.sessionID)).run()
  db.delete(InboxSessionEpochTable).where(eq(InboxSessionEpochTable.session_id, data.sessionID)).run()
  apply(db, data)
}

export function capture(sessionID: SessionID, db?: Database.TxOrDb): Snapshot {
  if (!db) return Database.use((db) => capture(sessionID, db))
  return parse(SnapshotSchema, {
    version: 1,
    sessionID,
    receipts: db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, sessionID)).orderBy(InboxTable.id).all(),
    lanes: db.select().from(InboxLaneStateTable).where(eq(InboxLaneStateTable.session_id, sessionID)).orderBy(InboxLaneStateTable.agent_id).all(),
    epoch: db.select().from(InboxSessionEpochTable).where(eq(InboxSessionEpochTable.session_id, sessionID)).get() ?? null,
  })
}

// Call inside the transaction that produced these after-images. Repeated rows retain their final image.
export function record(delta: Delta): void {
  const data = parse(DeltaSchema, {
    ...delta,
    receipts: delta.receipts ? [...new Map(delta.receipts.map((row) => [row.id, row])).values()] : undefined,
    lanes: delta.lanes ? [...new Map(delta.lanes.map((row) => [row.agent_id, row])).values()] : undefined,
  })
  if (!data.receipts?.length && !data.deletedReceiptIDs?.length && !data.lanes?.length && !data.epoch) return
  SyncEvent.run(Event.Delta, data)
}

export function snapshot(sessionID: SessionID): Snapshot {
  return Database.transaction((db) => {
    const data = capture(sessionID, db)
    SyncEvent.run(Event.Snapshot, parse(SnapshotSchema, data))
    return data
  })
}

export function historyReceiptKey(source: string, sourceKey: string, messageID: string) {
  return `import-history:${JSON.stringify([source, sourceKey, messageID])}`
}

export function materializeHistory(input: {
  sessionID: SessionID
  source: string
  sourceKey: string
  messages: readonly { id: MessageID; role: string; agentID?: string }[]
  replacedMessageIDs?: readonly MessageID[]
}, db: Database.TxOrDb): void {
  const current = capture(input.sessionID, db)
  const replaced = new Set(input.replacedMessageIDs ?? [])
  const deletedReceiptIDs = current.receipts.filter((row) =>
    row.input_message_id && replaced.has(row.input_message_id) &&
    row.idempotency_key === historyReceiptKey(input.source, input.sourceKey, row.input_message_id as string),
  ).map((row) => row.id)
  const now = Date.now()
  const receipts: Snapshot["receipts"] = input.messages.filter((message) => message.role === "user").map((message) => {
    const key = historyReceiptKey(input.source, input.sourceKey, message.id)
    return {
      id: `${input.sessionID}:${key}`,
      receiver_session_id: input.sessionID,
      receiver_actor_id: message.agentID ?? "main",
      sender_session_id: null,
      sender_actor_id: null,
      type: "prompt",
      content: null,
      input_message_id: message.id,
      state: "settled",
      epoch: current.epoch?.epoch ?? 0,
      run_id: null,
      claim_frontier: null,
      consumed: true,
      outcome: null,
      delivery_message_id: null,
      error: null,
      idempotency_key: key,
      created_at: now,
      time_updated: now,
    }
  })
  // Importing a transcript authorizes history, not a new execution or a claimed success.
  SyncEvent.run(Event.Delta, {
    sessionID: input.sessionID, receipts, deletedReceiptIDs,
  }, { publish: false })
}
