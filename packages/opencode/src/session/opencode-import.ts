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

type OcSession = {
  id: string
  project_id: string
  parent_id: string | null
  slug: string
  directory: string
  title: string
  version: string
  share_url: string | null
  summary_additions: number | null
  summary_deletions: number | null
  summary_files: number | null
  summary_diffs: string | null
  revert: string | null
  permission: string | null
  time_created: number
  time_updated: number
  time_compacting: number | null
  time_archived: number | null
  workspace_id: string | null
}

type OcMessage = {
  id: string
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
        if (existing && existing.source_mtime === sess.time_updated && !opts?.force) {
          stats.skipped++
          continue
        }

        // If this import previously created a mimocode session that the user has
        // since deleted, drop the stale mapping and re-import fresh (otherwise the
        // update below touches zero rows and the message FK insert fails). When it
        // still exists, remember its time_updated so a re-sync never moves the
        // session backward past mimocode-native activity (cc/codex parity).
        let existingUpdated: number | undefined
        if (existing) {
          const mimoSess = Database.use((db) =>
            db.select({ updated: SessionTable.time_updated }).from(SessionTable).where(eq(SessionTable.id, existing!.session_id)).get(),
          )
          if (!mimoSess) {
            Database.use((db) =>
              db.delete(ExternalImportTable).where(and(eq(ExternalImportTable.source, "opencode"), eq(ExternalImportTable.source_key, sourceKey))).run(),
            )
            existing = undefined
          } else {
            existingUpdated = mimoSess.updated
          }
        }

        const project = resolveProject(sess.directory)
        const now = Date.now()

        const messages = srcDb.all("SELECT * FROM message WHERE session_id = ? ORDER BY id", sess.id) as OcMessage[]
        if (messages.length === 0) {
          stats.skipped++
          continue
        }

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

        Database.transaction((tx) => {
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
            if (existing.message_ids?.length) {
              for (let i = 0; i < existing.message_ids.length; i += 500)
                tx.delete(MessageTable)
                  .where(inArray(MessageTable.id, existing.message_ids.slice(i, i + 500)))
                  .run()
            } else {
              tx.delete(MessageTable).where(eq(MessageTable.session_id, sess.id as SessionID)).run()
            }
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
              .values({
                id: sess.id as SessionID,
                project_id: project.id,
                parent_id: sess.parent_id as SessionID | null,
                slug: sess.slug,
                directory: sess.directory,
                title: sess.title,
                version: sess.version,
                time_created: sess.time_created,
                time_updated: sess.time_updated,
              })
              .onConflictDoUpdate({
                target: SessionTable.id,
                set: {
                  project_id: project.id,
                  directory: sess.directory,
                  time_updated: sess.time_updated,
                },
              })
              .run()
          }

          for (const m of messages) {
            const data = typeof m.data === "string" ? JSON.parse(m.data) : m.data
            tx.insert(MessageTable)
              .values({
                id: m.id as MessageID,
                session_id: sess.id as SessionID,
                agent_id: "main",
                time_created: m.time_created,
                data,
              })
              .onConflictDoUpdate({
                target: MessageTable.id,
                set: { data, time_created: m.time_created },
              })
              .run()
          }

          for (const p of parts) {
            const data = typeof p.data === "string" ? JSON.parse(p.data) : p.data
            tx.insert(PartTable)
              .values({
                id: p.id as PartID,
                message_id: p.message_id as MessageID,
                session_id: sess.id as SessionID,
                time_created: p.time_created,
                data,
              })
              .onConflictDoUpdate({
                target: PartTable.id,
                set: { data, time_created: p.time_created },
              })
              .run()
          }

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
        })

        if (existing) stats.resynced++
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
