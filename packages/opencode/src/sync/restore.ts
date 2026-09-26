import z from "zod"
import { isDeepStrictEqual } from "node:util"
import { Database, eq } from "@/storage"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { EventSequenceTable, EventTable } from "./event.sql"
import { SyncEvent } from "."
import * as QueueSync from "@/turn-queue/sync"

export const ReplayEventSchema = z.object({
  id: z.string(),
  aggregateID: z.string(),
  seq: z.number().int().nonnegative(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
})

export class RestoreConflict extends Error {}
export class RestorePayloadError extends Error {}

function normalizeSnapshot(snapshot: QueueSync.Snapshot): QueueSync.Snapshot {
  return {
    ...snapshot,
    receipts: snapshot.receipts.toSorted((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    lanes: snapshot.lanes.toSorted((a, b) => a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0),
  }
}

export function installRestore(input: {
  events: SyncEvent.SerializedEvent[]
  queueSnapshot: QueueSync.Snapshot
  finalSeq: number
  workspaceID: string
  isIdle: () => boolean
}) {
  const snapshot = normalizeSnapshot(QueueSync.SnapshotSchema.parse(input.queueSnapshot))
  const sessionID = snapshot.sessionID
  const { events } = input
  if (snapshot.receipts.some((receipt) => receipt.state === "claimed"))
    throw new RestoreConflict("Cannot transfer unresolved execution claims")
  if (!events.length || events[0].seq !== 0 || events.at(-1)?.seq !== input.finalSeq)
    throw new RestorePayloadError("Restore requires a complete event history through finalSeq")
  for (const [index, event] of events.entries()) {
    if (event.aggregateID !== sessionID || event.seq !== index)
      throw new RestorePayloadError("Restore event history has a foreign session or sequence gap")
    const definition = SyncEvent.registry.get(event.type)
    if (!definition) throw new RestorePayloadError(`Unknown event type: ${event.type}`)
    const payload = definition.schema.parse(event.data) as Record<string, unknown>
    if (payload[definition.aggregate] !== sessionID)
      throw new RestorePayloadError("Event payload belongs to another session")
  }
  return Database.transaction((db) => {
    if (!input.isIdle()) throw new RestoreConflict("Cannot restore into an active session")
    const existing = db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
    const sequence = db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get()
    if (existing || sequence) {
      const stored = db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).orderBy(EventTable.seq).all()
      const identical = stored.length === events.length && stored.every((event, index) => {
        const incoming = events[index]
        return event.id === incoming.id && event.seq === incoming.seq && event.type === incoming.type &&
          isDeepStrictEqual(event.data, incoming.data)
      })
      if (sequence?.seq === input.finalSeq && identical && existing?.workspace_id === input.workspaceID &&
          isDeepStrictEqual(normalizeSnapshot(QueueSync.capture(sessionID, db)), snapshot)) return sessionID
      throw new RestoreConflict("Restore conflicts with an existing or newer session")
    }
    const messageOwners = new Map<string, string>()
    for (const event of events) {
      const info = event.data.info as Record<string, unknown> | undefined
      const part = event.data.part as Record<string, unknown> | undefined
      if (event.type.startsWith("session.created.")) {
        if (info?.id !== sessionID) throw new RestorePayloadError("Created session ID does not match restore")
      }
      if (event.type.startsWith("message.updated.")) {
        if (!info || info.sessionID !== sessionID || typeof info.id !== "string")
          throw new RestorePayloadError("Message belongs to another session")
        const current = db.select().from(MessageTable).where(eq(MessageTable.id, MessageID.make(info.id))).get()
        if (current && current.session_id !== sessionID) throw new RestorePayloadError("Message ID belongs to another session")
        messageOwners.set(info.id, sessionID)
      }
      if (event.type.startsWith("message.part.updated.")) {
        if (!part || part.sessionID !== sessionID || typeof part.id !== "string" || typeof part.messageID !== "string")
          throw new RestorePayloadError("Part belongs to another session")
        const current = db.select().from(PartTable).where(eq(PartTable.id, PartID.make(part.id))).get()
        if (current && (current.session_id !== sessionID || current.message_id !== part.messageID))
          throw new RestorePayloadError("Part ID belongs to another message")
        const parent = db.select().from(MessageTable).where(eq(MessageTable.id, MessageID.make(part.messageID))).get()
        if (parent && parent.session_id !== sessionID) throw new RestorePayloadError("Part parent belongs to another session")
        if (!parent && messageOwners.get(part.messageID) !== sessionID)
          throw new RestorePayloadError("Part parent is missing from restore history")
      }
    }
    SyncEvent.replayAll(events)
    const restored = db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
    if (!restored || restored.workspace_id !== input.workspaceID)
      throw new RestorePayloadError("Restored session does not belong to the target workspace")
    QueueSync.applySnapshot(snapshot, db)
    return SessionID.make(sessionID)
  }, { behavior: "immediate" })
}
