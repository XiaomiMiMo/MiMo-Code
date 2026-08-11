import { NotFoundError, eq, and, sql } from "../storage"
import { SyncEvent } from "@/sync"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionTable, MessageTable, PartTable } from "./session.sql"
import { ActorRegistryTable } from "@/actor/actor.sql"
import { ACTIVITY_COALESCE_MS } from "@/actor/schema"
import { Log } from "../util"

const log = Log.create({ service: "session.projector" })

function foreign(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("code" in err && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true
  return "message" in err && typeof err.message === "string" && err.message.includes("FOREIGN KEY constraint failed")
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T

function grab<T extends object, K1 extends keyof T, X>(
  obj: T,
  field1: K1,
  cb?: (val: NonNullable<T[K1]>) => X,
): X | undefined {
  if (obj == undefined || !(field1 in obj)) return undefined

  const val = obj[field1]
  if (val && typeof val === "object" && cb) {
    return cb(val)
  }
  if (val === undefined) {
    throw new Error(
      "Session update failure: pass `null` to clear a field instead of `undefined`: " + JSON.stringify(obj),
    )
  }
  return val as X | undefined
}

export function toPartialRow(info: DeepPartial<Session.Info>) {
  const obj = {
    id: grab(info, "id"),
    project_id: grab(info, "projectID"),
    workspace_id: grab(info, "workspaceID"),
    parent_id: grab(info, "parentID"),
    context_from: grab(info, "contextFrom"),
    context_watermark: grab(info, "contextWatermark"),
    slug: grab(info, "slug"),
    directory: grab(info, "directory"),
    title: grab(info, "title"),
    version: grab(info, "version"),
    share_url: grab(info, "share", (v) => grab(v, "url")),
    summary_additions: grab(info, "summary", (v) => grab(v, "additions")),
    summary_deletions: grab(info, "summary", (v) => grab(v, "deletions")),
    summary_files: grab(info, "summary", (v) => grab(v, "files")),
    summary_diffs: grab(info, "summary", (v) => grab(v, "diffs")),
    revert: grab(info, "revert"),
    permission: grab(info, "permission"),
    time_created: grab(info, "time", (v) => grab(v, "created")),
    time_updated: grab(info, "time", (v) => grab(v, "updated")),
    time_compacting: grab(info, "time", (v) => grab(v, "compacting")),
    time_archived: grab(info, "time", (v) => grab(v, "archived")),
  }

  return Object.fromEntries(Object.entries(obj).filter(([_, val]) => val !== undefined))
}

export default [
  SyncEvent.project(Session.Event.Created, (db, data) => {
    db.insert(SessionTable).values(Session.toRow(data.info)).run()
  }),

  SyncEvent.project(Session.Event.Updated, (db, data) => {
    const info = data.info
    const row = db
      .update(SessionTable)
      .set(toPartialRow(info))
      .where(eq(SessionTable.id, data.sessionID))
      .returning()
      .get()
    if (!row) throw new NotFoundError({ message: `Session not found: ${data.sessionID}` })
  }),

  SyncEvent.project(Session.Event.Deleted, (db, data) => {
    db.delete(SessionTable).where(eq(SessionTable.id, data.sessionID)).run()
  }),

  SyncEvent.project(MessageV2.Event.Updated, (db, data) => {
    const time_created = data.info.time.created
    const { id, sessionID, agentID, ...rest } = data.info

    try {
      db.insert(MessageTable)
        .values({
          id,
          session_id: sessionID,
          agent_id: agentID ?? "main",
          time_created,
          data: rest,
        })
        .onConflictDoUpdate({ target: MessageTable.id, set: { agent_id: agentID ?? "main", data: rest } })
        .run()
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late message update", { messageID: id, sessionID })
    }
  }),

  SyncEvent.project(MessageV2.Event.Removed, (db, data) => {
    db.delete(MessageTable)
      .where(and(eq(MessageTable.id, data.messageID), eq(MessageTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartRemoved, (db, data) => {
    db.delete(PartTable)
      .where(and(eq(PartTable.id, data.partID), eq(PartTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartUpdated, (db, data) => {
    const { id, messageID, sessionID, ...rest } = data.part

    try {
      db.insert(PartTable)
        .values({
          id,
          message_id: messageID,
          session_id: sessionID,
          time_created: data.time,
          data: rest,
        })
        .onConflictDoUpdate({ target: PartTable.id, set: { data: rest } })
        .run()
      // Activity heartbeat for actor liveness (actor/schema.ts deriveLiveness).
      // This projector is the single writer of `part` rows, so it is the one
      // place that already fires on every part write — no new hook in the session
      // loop. Sequenced after the insert so activity is recorded only if the part
      // actually landed. `part` carries no agent id (the agent slice lives on
      // `message`), so the owning actor is resolved through the message's primary
      // key; together with session_id that hits actor_registry's PK directly. A
      // 0-row no-op when the session has no registry row, exactly like updateTurn.
      //
      // Coalesced to at most one write per actor per ACTIVITY_COALESCE_MS. The
      // part-write path this hangs off is unthrottled — the bash tool's
      // ctx.metadata fires per decoded stdout chunk — which measured 539-867 of
      // these UPDATEs per second, each running the correlated subquery below,
      // while the only consumers (deriveLiveness's 6m stall display and 10m
      // abandonment bound) cannot resolve anything finer than tens of seconds.
      // The staleness predicate is part of the WHERE rather than a process-local
      // cache so it stays correct across instances and restarts, and it also
      // makes the column monotonic: an out-of-order event carrying an older
      // `data.time` no longer drags it backwards. `IS NULL` is the first
      // disjunct because the column is nullable and a fresh row records NULL,
      // which must still take its first write (AGENTS.md, "Reading a nullable
      // column").
      db.update(ActorRegistryTable)
        .set({ last_activity_time: data.time })
        .where(
          and(
            eq(ActorRegistryTable.session_id, sessionID),
            eq(
              ActorRegistryTable.actor_id,
              sql`(SELECT ${MessageTable.agent_id} FROM ${MessageTable} WHERE ${MessageTable.id} = ${messageID})`,
            ),
            sql`(${ActorRegistryTable.last_activity_time} IS NULL OR ${ActorRegistryTable.last_activity_time} < ${data.time - ACTIVITY_COALESCE_MS})`,
          ),
        )
        .run()
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late part update", { partID: id, messageID, sessionID })
    }
  }),
]
