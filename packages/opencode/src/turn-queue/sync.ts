import z from "zod"
import { Database, eq, NotFoundError } from "@/storage"
import { SyncEvent } from "@/sync"
import { MessageID, SessionID } from "@/session/schema"
import { MessageTable, SessionTable } from "@/session/session.sql"
import { TurnLaneStateTable, TurnLegacyBootstrapTable, TurnReceiptTable, TurnSessionEpochTable } from "./turn-queue.sql"

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

export const IntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), messageID: MessageID.zod }),
  z.object({ kind: z.literal("resume"), assistantID: MessageID.zod, plan: z.enum(["user-resume", "tool-resume"]), expectedAssistantStatus: z.string().optional() }),
  z.object({ kind: z.literal("wake"), receiverActorID: z.string(), inboxWatermark: z.string() }),
  z.object({ kind: z.literal("shell"), command: z.string(), cwd: z.string().optional() }),
])

export const ReceiptRowSchema = z.object({
  id: z.string().min(1),
  session_id: SessionID.zod,
  agent_id: z.string(),
  state: z.enum(["accepted", "claimed", "settled", "cancelled", "rejected"]),
  intent: IntentSchema,
  epoch: z.number().int().nonnegative(),
  run_id: z.number().int().nullable(),
  claim_frontier: MessageID.zod.nullable(),
  consumed: z.boolean(),
  suspended: z.boolean(),
  outcome: z.enum(["success", "assistant_error", "interrupted", "never_ran"]).nullable(),
  message_id: MessageID.zod.nullable(),
  delivery_message_id: MessageID.zod.nullable(),
  error: z.string().nullable(),
  idempotency_key: z.string(),
  time_created: z.number().int(),
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

export const BootstrapRowSchema = z.object({
  session_id: SessionID.zod,
  message_ids: MessageID.zod.array(),
  completed: z.boolean(),
  time_updated: z.number().int(),
})

export const DeltaSchema = z.object({
  sessionID: SessionID.zod,
  receipts: ReceiptRowSchema.array().optional(),
  deletedReceiptIDs: z.string().min(1).array().optional(),
  lanes: LaneRowSchema.array().optional(),
  epoch: EpochRowSchema.optional(),
  bootstrap: BootstrapRowSchema.optional(),
})
export type Delta = {
  sessionID: SessionID
  receipts?: Array<typeof TurnReceiptTable.$inferSelect>
  deletedReceiptIDs?: string[]
  lanes?: Array<typeof TurnLaneStateTable.$inferSelect>
  epoch?: typeof TurnSessionEpochTable.$inferSelect
  bootstrap?: typeof TurnLegacyBootstrapTable.$inferSelect
}

export const SnapshotSchema = z.object({
  version: z.literal(1),
  sessionID: SessionID.zod,
  receipts: ReceiptRowSchema.array(),
  lanes: LaneRowSchema.array(),
  epoch: EpochRowSchema.nullable(),
  bootstrap: BootstrapRowSchema.nullable(),
})
export type Snapshot = z.infer<typeof SnapshotSchema>

export const Event = {
  Delta: SyncEvent.define({ type: "session.turn_queue.delta", version: 1, aggregate: "sessionID", schema: DeltaSchema }),
  Snapshot: SyncEvent.define({ type: "session.turn_queue.snapshot", version: 1, aggregate: "sessionID", schema: SnapshotSchema }),
}

function validate(db: Database.TxOrDb, data: Delta | Snapshot) {
  if (!db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, data.sessionID)).get())
    throw new NotFoundError({ message: `Session not found: ${data.sessionID}` })
  const rows = [...(data.receipts ?? []), ...(data.lanes ?? []), ...(data.epoch ? [data.epoch] : []), ...(data.bootstrap ? [data.bootstrap] : [])]
  if (rows.some((row) => row.session_id !== data.sessionID)) throw new QueueValidationError("Turn queue row belongs to another session")
  if (new Set(data.receipts?.map((row) => row.id)).size !== (data.receipts?.length ?? 0)) throw new QueueValidationError("Duplicate turn receipt ID")
  if (new Set(data.lanes?.map((row) => row.agent_id)).size !== (data.lanes?.length ?? 0)) throw new QueueValidationError("Duplicate turn lane")
  const deleted = "deletedReceiptIDs" in data ? data.deletedReceiptIDs ?? [] : []
  for (const id of new Set([...(data.receipts ?? []).map((row) => row.id), ...deleted])) {
    const current = db.select({ sessionID: TurnReceiptTable.session_id }).from(TurnReceiptTable)
      .where(eq(TurnReceiptTable.id, id)).get()
    if (current && current.sessionID !== data.sessionID) throw new QueueValidationError(`Turn receipt belongs to another session: ${id}`)
  }
  const references = new Set<MessageID>(data.bootstrap?.message_ids ?? [])
  for (const row of data.lanes ?? []) if (row.consumed_frontier) references.add(row.consumed_frontier)
  for (const row of data.receipts ?? []) {
    const intent = parse(IntentSchema, row.intent)
    if (intent.kind === "prompt") {
      references.add(intent.messageID)
      const message = db.select({ agentID: MessageTable.agent_id }).from(MessageTable).where(eq(MessageTable.id, intent.messageID)).get()
      if (message && message.agentID !== row.agent_id) throw new QueueValidationError(`Turn queue message belongs to another lane: ${intent.messageID}`)
    }
    if (intent.kind === "resume") references.add(intent.assistantID)
    if (row.message_id) references.add(row.message_id)
    if (row.delivery_message_id) references.add(row.delivery_message_id)
    if (row.claim_frontier) references.add(row.claim_frontier)
  }
  for (const id of references) {
    const message = db.select({ sessionID: MessageTable.session_id }).from(MessageTable).where(eq(MessageTable.id, id)).get()
    if (message && message.sessionID !== data.sessionID) throw new QueueValidationError(`Turn queue message belongs to another session: ${id}`)
  }
}

function apply(db: Database.TxOrDb, data: Delta | Snapshot) {
  for (const row of data.receipts ?? [])
    db.insert(TurnReceiptTable).values(row).onConflictDoUpdate({ target: TurnReceiptTable.id, set: row }).run()
  for (const row of data.lanes ?? [])
    db.insert(TurnLaneStateTable).values(row).onConflictDoUpdate({ target: [TurnLaneStateTable.session_id, TurnLaneStateTable.agent_id], set: row }).run()
  if (data.epoch)
    db.insert(TurnSessionEpochTable).values(data.epoch).onConflictDoUpdate({ target: TurnSessionEpochTable.session_id, set: data.epoch }).run()
  if (data.bootstrap)
    db.insert(TurnLegacyBootstrapTable).values(data.bootstrap).onConflictDoUpdate({ target: TurnLegacyBootstrapTable.session_id, set: data.bootstrap }).run()
}

export const projectors = [
  SyncEvent.project(Event.Delta, (db, value) => {
    const data = parse(DeltaSchema, value)
    validate(db, data)
    for (const id of data.deletedReceiptIDs ?? []) db.delete(TurnReceiptTable).where(eq(TurnReceiptTable.id, id)).run()
    apply(db, data)
  }),
  SyncEvent.project(Event.Snapshot, (db, data) => applySnapshot(data, db)),
]

export function applySnapshot(value: Snapshot, db: Database.TxOrDb): void {
  const data = parse(SnapshotSchema, value)
  validate(db, data)
  db.delete(TurnReceiptTable).where(eq(TurnReceiptTable.session_id, data.sessionID)).run()
  db.delete(TurnLaneStateTable).where(eq(TurnLaneStateTable.session_id, data.sessionID)).run()
  db.delete(TurnSessionEpochTable).where(eq(TurnSessionEpochTable.session_id, data.sessionID)).run()
  db.delete(TurnLegacyBootstrapTable).where(eq(TurnLegacyBootstrapTable.session_id, data.sessionID)).run()
  apply(db, data)
}

export function capture(sessionID: SessionID, db?: Database.TxOrDb): Snapshot {
  if (!db) return Database.use((db) => capture(sessionID, db))
  return parse(SnapshotSchema, {
    version: 1,
    sessionID,
    receipts: db.select().from(TurnReceiptTable).where(eq(TurnReceiptTable.session_id, sessionID)).orderBy(TurnReceiptTable.id).all(),
    lanes: db.select().from(TurnLaneStateTable).where(eq(TurnLaneStateTable.session_id, sessionID)).orderBy(TurnLaneStateTable.agent_id).all(),
    epoch: db.select().from(TurnSessionEpochTable).where(eq(TurnSessionEpochTable.session_id, sessionID)).get() ?? null,
    bootstrap: db.select().from(TurnLegacyBootstrapTable).where(eq(TurnLegacyBootstrapTable.session_id, sessionID)).get() ?? null,
  })
}

// Call inside the transaction that produced these after-images. Repeated rows retain their final image.
export function record(delta: Delta): void {
  const data = parse(DeltaSchema, {
    ...delta,
    receipts: delta.receipts ? [...new Map(delta.receipts.map((row) => [row.id, row])).values()] : undefined,
    lanes: delta.lanes ? [...new Map(delta.lanes.map((row) => [row.agent_id, row])).values()] : undefined,
  })
  if (!data.receipts?.length && !data.deletedReceiptIDs?.length && !data.lanes?.length && !data.epoch && !data.bootstrap) return
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
    row.intent.kind === "prompt" && replaced.has(row.intent.messageID as MessageID) &&
    row.idempotency_key === historyReceiptKey(input.source, input.sourceKey, row.intent.messageID as string),
  ).map((row) => row.id)
  const now = Date.now()
  const receipts: Snapshot["receipts"] = input.messages.filter((message) => message.role === "user").map((message) => {
    const key = historyReceiptKey(input.source, input.sourceKey, message.id)
    return {
      id: `${input.sessionID}:${key}`, session_id: input.sessionID, agent_id: message.agentID ?? "main",
      state: "settled", intent: { kind: "prompt", messageID: message.id }, epoch: current.epoch?.epoch ?? 0,
      run_id: null, claim_frontier: null, consumed: true, suspended: false, outcome: null,
      message_id: null, delivery_message_id: null, error: null, idempotency_key: key,
      time_created: now, time_updated: now,
    }
  })
  // Importing a transcript authorizes history, not a new execution or a claimed success.
  SyncEvent.run(Event.Delta, {
    sessionID: input.sessionID, receipts, deletedReceiptIDs,
    ...(!current.bootstrap ? { bootstrap: { session_id: input.sessionID, message_ids: [], completed: true, time_updated: now } } : {}),
  }, { publish: false })
}
