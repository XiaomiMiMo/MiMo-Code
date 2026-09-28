import { indexImportedParts } from "../history/import"
import { existsSync } from "fs"
import { Log } from "../util"
import { Database, eq, and, inArray } from "../storage"
import { openReadonly, type ReadonlyDb } from "../storage/read-sqlite"
import { ProjectTable } from "../project/project.sql"
import { ProjectID } from "../project/schema"
import { resolveMainGitDir, resolveProjectId } from "../project/project-id"
import { SessionTable, MessageTable, PartTable } from "./session.sql"
import { ExternalImportTable } from "./external-import.sql"
import type { SessionID, MessageID, PartID } from "./schema"
import * as QueueSync from "../turn-queue/sync"
import { isDeepStrictEqual } from "node:util"

const log = Log.create({ service: "opencode-import" })

export const DEFAULT_DB_PATH = (() => {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg || `${process.env.HOME || process.env.USERPROFILE}/.local/share`
  return `${base}/opencode/opencode.db`
})()

function resolveProject(cwd: string): { id: ProjectID; worktree: string; vcs: string | null } {
  if (!cwd || !existsSync(cwd)) return { id: ProjectID.global, worktree: cwd || "/", vcs: null }
  if (!resolveMainGitDir(cwd)) return { id: ProjectID.global, worktree: cwd, vcs: null }
  return { id: resolveProjectId(cwd), worktree: cwd, vcs: "git" }
}

type SessionRow = typeof SessionTable.$inferSelect
type OcSession = Omit<SessionRow, "summary_diffs" | "revert" | "permission" | "prompt" | "auto_worktree_hint_sent"> & {
  summary_diffs: string | SessionRow["summary_diffs"]
  revert: string | SessionRow["revert"]
  permission: string | SessionRow["permission"]
  prompt: string | SessionRow["prompt"]
  auto_worktree_hint_sent: number | boolean | null
}

function nativeSessionRow(session: OcSession, projectID: ProjectID): SessionRow {
  const json = <T>(value: string | T | undefined): T | null => typeof value === "string" ? JSON.parse(value) : value ?? null
  return {
    id: session.id, project_id: projectID, workspace_id: session.workspace_id ?? null,
    parent_id: session.parent_id ?? null, context_from: session.context_from ?? null, context_watermark: session.context_watermark ?? null,
    slug: session.slug, directory: session.directory, title: session.title,
    title_source: session.title_source ?? "user", title_revision: session.title_revision ?? 0, version: session.version,
    share_url: session.share_url ?? null, summary_additions: session.summary_additions ?? null,
    summary_deletions: session.summary_deletions ?? null, summary_files: session.summary_files ?? null,
    summary_diffs: json<SessionRow["summary_diffs"]>(session.summary_diffs), revert: json<SessionRow["revert"]>(session.revert),
    permission: json<SessionRow["permission"]>(session.permission), prompt: json<SessionRow["prompt"]>(session.prompt),
    time_created: session.time_created, time_updated: session.time_updated,
    time_compacting: session.time_compacting ?? null, time_archived: session.time_archived ?? null,
    last_checkpoint_message_id: session.last_checkpoint_message_id ?? null,
    auto_worktree_hint_sent: session.auto_worktree_hint_sent == null ? null : !!session.auto_worktree_hint_sent,
  }
}

type OcMessage = {
  id: string
  agent_id?: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

type OcPart = {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

export type ImportStats = {
  scanned: number
  imported: number
  resynced: number
  skipped: number
  errors: string[]
}

const BATCH = 200

export async function run(opts?: { force?: boolean; dbPath?: string }): Promise<ImportStats> {
  const dbPath = opts?.dbPath ?? DEFAULT_DB_PATH
  const stats: ImportStats = { scanned: 0, imported: 0, resynced: 0, skipped: 0, errors: [] }
  if (!existsSync(dbPath)) return stats

  let srcDb: ReadonlyDb
  try {
    srcDb = openReadonly(dbPath)
  } catch (e) {
    stats.errors.push(`failed to open ${dbPath}: ${e}`)
    return stats
  }

  try {
    const hasSessionTable = srcDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='session'")
    if (!hasSessionTable) {
      stats.errors.push(`${dbPath}: missing 'session' table`)
      return stats
    }

    srcDb.get("BEGIN")
    const queueTables = ["turn_receipt", "turn_lane_state", "turn_session_epoch", "turn_legacy_bootstrap"]
    const present = queueTables.filter((name) => srcDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name))
    if (present.length > 0 && present.length !== queueTables.length) throw new Error("Incomplete source turn queue schema")
    const hasQueue = present.length === queueTables.length
    const sessions = srcDb.all("SELECT * FROM session ORDER BY time_created DESC") as OcSession[]

    for (const sess of sessions) {
      stats.scanned++
      try {
        const sourceKey = sess.id
        let existing = Database.use((db) =>
          db
            .select()
            .from(ExternalImportTable)
            .where(and(eq(ExternalImportTable.source, "opencode"), eq(ExternalImportTable.source_key, sourceKey)))
            .get(),
        )
        // Skip only when the source session is unchanged since last import. We
        // store time_updated as source_mtime, so a re-edited opencode session
        // (newer time_updated) is picked up automatically — matching the cc/codex
        // mtime-based resync behavior. force overrides the staleness check.
        if (!hasQueue && existing && existing.source_mtime === sess.time_updated && !opts?.force) {
          stats.skipped++
          continue
        }

        const ownedMessageIDs = existing?.message_ids
        if (existing && ownedMessageIDs == null) throw new Error("Cannot resync: imported message ownership is missing")

        if (existing && existing.session_id !== sess.id) throw new Error("Imported session ownership conflicts with the source")
        let existingUpdated: number | undefined
        if (existing) {
          const mimoSess = Database.use((db) =>
            db.select({ updated: SessionTable.time_updated }).from(SessionTable).where(eq(SessionTable.id, existing!.session_id)).get(),
          )
          if (!mimoSess) {
            existing = undefined
          } else {
            existingUpdated = mimoSess.updated
          }
        }

        const project = resolveProject(sess.directory)
        const now = Date.now()

        const messages = srcDb.all("SELECT * FROM message WHERE session_id = ? ORDER BY id", sess.id) as OcMessage[]
        if (!hasQueue && messages.length === 0) {
          stats.skipped++
          continue
        }

        const queue = hasQueue ? QueueSync.SnapshotSchema.parse({
          version: 1, sessionID: sess.id,
          receipts: (srcDb.all("SELECT * FROM turn_receipt WHERE session_id = ? ORDER BY id", sess.id) as Record<string, unknown>[])
            .map((row) => ({ ...row, intent: typeof row.intent === "string" ? JSON.parse(row.intent) : row.intent,
              consumed: !!row.consumed, suspended: !!row.suspended })),
          lanes: srcDb.all("SELECT * FROM turn_lane_state WHERE session_id = ? ORDER BY agent_id", sess.id),
          epoch: srcDb.get("SELECT * FROM turn_session_epoch WHERE session_id = ?", sess.id),
          bootstrap: (() => {
            const row = srcDb.get("SELECT * FROM turn_legacy_bootstrap WHERE session_id = ?", sess.id) as Record<string, unknown> | null
            return row ? { ...row, message_ids: typeof row.message_ids === "string" ? JSON.parse(row.message_ids) : row.message_ids,
              completed: !!row.completed } : null
          })(),
        }) : undefined
        const parsedMessages = messages.map((message) => {
          const data = typeof message.data === "string" ? JSON.parse(message.data) : message.data
          const agentID = message.agent_id ?? data.agentID ?? "main"
          delete data.agentID
          if (!queue && data.role === "user") delete data.queueAdmission
          return { ...message, agent_id: agentID as string, data }
        })
        const messageIds = messages.map((m) => m.id as MessageID)

        const parts: OcPart[] = []
        for (let i = 0; i < messageIds.length; i += BATCH) {
          const batch = messageIds.slice(i, i + BATCH)
          const placeholders = batch.map(() => "?").join(",")
          const batchParts = srcDb.all(
            `SELECT * FROM part WHERE session_id = ? AND message_id IN (${placeholders}) ORDER BY id`,
            sess.id,
            ...batch,
          ) as OcPart[]
          parts.push(...batchParts)
        }

        const parsedParts = parts.map((part) => ({ ...part, data: typeof part.data === "string" ? JSON.parse(part.data) : part.data }))
        const nativeRow = queue ? nativeSessionRow(sess, project.id) : undefined
        let unchanged = false
        Database.transaction((tx) => {
          const target = tx.select().from(SessionTable).where(eq(SessionTable.id, sess.id as SessionID)).get()
          if (queue && target) {
            const currentMessages = tx.select({ id: MessageTable.id, agent_id: MessageTable.agent_id, time_created: MessageTable.time_created, time_updated: MessageTable.time_updated, data: MessageTable.data })
              .from(MessageTable).where(eq(MessageTable.session_id, target.id)).orderBy(MessageTable.id).all()
            const currentParts = tx.select({ id: PartTable.id, message_id: PartTable.message_id, time_created: PartTable.time_created, time_updated: PartTable.time_updated, data: PartTable.data })
              .from(PartTable).where(eq(PartTable.session_id, target.id)).orderBy(PartTable.id).all()
            if (!isDeepStrictEqual(target, nativeRow) || !isDeepStrictEqual(QueueSync.capture(target.id, tx), queue) ||
                !isDeepStrictEqual(currentMessages, parsedMessages.map(({ id, agent_id, time_created, time_updated, data }) => ({ id, agent_id, time_created, time_updated, data }))) ||
                !isDeepStrictEqual(currentParts, parsedParts.map(({ id, message_id, time_created, time_updated, data }) => ({ id, message_id, time_created, time_updated, data })).sort((a, b) => a.id.localeCompare(b.id))))
              throw new Error(`Imported session conflicts with existing session: ${sess.id}`)
            unchanged = true
            return
          }
          if (target && !existing) throw new Error("Imported session ownership conflicts with an existing session")
          const owned = new Set(existing ? ownedMessageIDs! : [])
          const checkedIDs = [...new Set([...messageIds, ...owned])]
          for (let i = 0; i < checkedIDs.length; i += BATCH) {
            const current = tx.select({ id: MessageTable.id, sessionID: MessageTable.session_id }).from(MessageTable)
              .where(inArray(MessageTable.id, checkedIDs.slice(i, i + BATCH))).all()
            if (current.some((row) => row.sessionID !== sess.id || !owned.has(row.id)))
              throw new Error("Imported message ownership conflicts with existing data")
          }
          for (let i = 0; i < parts.length; i += BATCH) {
            const current = tx.select({ sessionID: PartTable.session_id, messageID: PartTable.message_id }).from(PartTable)
              .where(inArray(PartTable.id, parts.slice(i, i + BATCH).map((part) => part.id as PartID))).all()
            if (current.some((row) => row.sessionID !== sess.id || !owned.has(row.messageID)))
              throw new Error("Imported part ownership conflicts with existing data")
          }
          tx.insert(ProjectTable)
            .values({
              id: project.id,
              worktree: project.worktree,
              vcs: project.vcs,
              sandboxes: [],
              time_created: sess.time_created,
              time_updated: sess.time_updated,
            })
            .onConflictDoNothing()
            .run()

          if (existing) {
            for (let i = 0; i < ownedMessageIDs!.length; i += 500)
              tx.delete(MessageTable)
                .where(inArray(MessageTable.id, ownedMessageIDs!.slice(i, i + 500)))
                .run()
            tx.update(SessionTable)
              .set({
                project_id: project.id,
                directory: sess.directory,
                version: sess.version,
                time_updated: Math.max(existingUpdated ?? 0, sess.time_updated),
              })
              .where(eq(SessionTable.id, sess.id as SessionID))
              .run()
          } else {
            tx.insert(SessionTable)
              .values(nativeRow ?? {
                id: sess.id as SessionID,
                project_id: project.id,
                parent_id: sess.parent_id as SessionID | null,
                slug: sess.slug,
                directory: sess.directory,
                title: sess.title.trim() ? sess.title : "Untitled",
                title_source: sess.title.trim() ? "user" : "fallback",
                title_revision: 0,
                version: sess.version,
                time_created: sess.time_created,
                time_updated: sess.time_updated,
              })
              .run()
          }

          for (const m of parsedMessages) {
            const data = m.data
            tx.insert(MessageTable)
              .values({
                id: m.id as MessageID,
                session_id: sess.id as SessionID,
                agent_id: m.agent_id,
                time_created: m.time_created,
                time_updated: m.time_updated,
                data,
              })
              .run()
          }

          for (const p of parsedParts) {
            const data = p.data
            tx.insert(PartTable)
              .values({
                id: p.id as PartID,
                message_id: p.message_id as MessageID,
                session_id: sess.id as SessionID,
                time_created: p.time_created,
                time_updated: p.time_updated,
                data,
              })
              .run()
          }

          indexImportedParts(tx, parts.map((p) => p.id))
          if (queue) QueueSync.applySnapshot(queue, tx)
          else QueueSync.materializeHistory({
            sessionID: sess.id as SessionID, source: "opencode", sourceKey,
            messages: parsedMessages.map((message) => ({ id: message.id as MessageID, role: message.data.role, agentID: message.agent_id })),
            replacedMessageIDs: existing?.message_ids ?? [],
          }, tx)

          tx.insert(ExternalImportTable)
            .values({
              source: "opencode",
              source_key: sourceKey,
              session_id: sess.id as SessionID,
              source_path: dbPath,
              source_mtime: sess.time_updated,
              time_imported: now,
              message_ids: messageIds,
            })
            .onConflictDoUpdate({
              target: [ExternalImportTable.source, ExternalImportTable.source_key],
              set: { source_mtime: sess.time_updated, time_imported: now, message_ids: messageIds },
            })
            .run()
        }, { behavior: "immediate" })

        if (unchanged) stats.skipped++
        else if (existing) stats.resynced++
        else stats.imported++
      } catch (e) {
        stats.errors.push(`session ${sess.id}: ${e}`)
      }
    }
  } finally {
    srcDb.close()
  }

  if (stats.imported + stats.resynced > 0 || stats.errors.length > 0)
    log.info("opencode import", { ...stats, errors: stats.errors.length })
  return stats
}

export * as OpencodeImport from "./opencode-import"
