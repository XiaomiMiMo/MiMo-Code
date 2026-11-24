// Desktop data migration: merge another device's engine database into this one.
//
// Pure SQL over a caller-provided SQLite handle (node:sqlite DatabaseSync and bun:sqlite
// Database share this shape). It never touches the engine's global paths, logging or its
// Database singleton, so Desktop can load this module alone inside a worker thread with its
// own connection while the engine is paused.
//
// Rules (see Desktop docs/specs/10-settings/data-migration/design.md D5 / D8):
// - Copy only columns present in both databases (tolerates additive schema drift); refuse when
//   the incoming database was migrated by a newer engine than this one.
// - Projects with the same id are updated in place (ON CONFLICT DO UPDATE). Never INSERT OR
//   REPLACE: REPLACE deletes first and the session foreign key cascades away local sessions.
// - task_event ids are autoincrement and are not copied. history_fts has no foreign key, so
//   rows of overwritten sessions are deleted explicitly. session_prefix_snapshot (a cache) and
//   external_import (machine paths) are not migrated.

import { createHash } from "node:crypto"

export interface SqlStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

export interface SqlHandle {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
}

/** Tables keyed by a session column, copied for imported sessions, in insertion order. */
const SESSION_TABLES: ReadonlyArray<{ table: string; column: string; skip?: readonly string[] }> = [
  { table: "session", column: "id" },
  { table: "message", column: "session_id" },
  { table: "part", column: "session_id" },
  { table: "todo", column: "session_id" },
  { table: "task", column: "session_id" },
  { table: "task_event", column: "session_id", skip: ["id"] },
  { table: "inbox", column: "receiver_session_id" },
  { table: "inbox_lane_state", column: "session_id" },
  { table: "inbox_session_epoch", column: "session_id" },
  { table: "actor_registry", column: "session_id" },
  { table: "workflow_run", column: "session_id" },
  { table: "history_fts", column: "session_id" },
]

/** Session-keyed tables without a cascading foreign key: cleaned up explicitly on overwrite. */
const UNCASCADED = ["part", "history_fts", "inbox", "session_prefix_snapshot", "external_import"]

export class MigrationEngineVersionError extends Error {
  constructor(
    readonly incoming: number,
    readonly local: number,
  ) {
    super("the incoming data was written by a newer version of the engine")
    this.name = "MigrationEngineVersionError"
  }
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

function hasTable(db: SqlHandle, schema: string, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(table)
}

function columns(db: SqlHandle, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all() as { name: string }[]).map((c) => c.name)
}

/** Creation time of the newest applied engine migration (0 when unknown). */
export function schemaVersion(db: SqlHandle, schema = "main"): number {
  if (!hasTable(db, schema, "__drizzle_migrations")) return 0
  const row = db.prepare(`SELECT max(created_at) AS v FROM ${schema}.__drizzle_migrations`).get() as { v: number | null }
  return Number(row?.v ?? 0)
}

export interface SessionInfo {
  id: string
  title: string
  updatedAt: number
  messages: number
  fingerprint: string
}

/**
 * Top-level sessions with a content fingerprint. Two devices hold the same content when the
 * fingerprints match; child sessions follow their top-level session.
 */
export function sessionInfos(db: SqlHandle, schema = "main"): Map<string, SessionInfo> {
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.time_updated, s.time_archived,
              (SELECT count(*) FROM ${schema}.message m WHERE m.session_id = s.id) AS messages,
              (SELECT max(m.id) FROM ${schema}.message m WHERE m.session_id = s.id) AS last_message,
              (SELECT max(m.time_updated) FROM ${schema}.message m WHERE m.session_id = s.id) AS message_updated,
              (SELECT count(*) FROM ${schema}.part p WHERE p.session_id = s.id) AS parts,
              (SELECT max(p.time_updated) FROM ${schema}.part p WHERE p.session_id = s.id) AS part_updated
       FROM ${schema}.session s WHERE s.parent_id IS NULL`,
    )
    .all() as Array<{
    id: string
    title: string
    time_updated: number
    time_archived: number | null
    messages: number
    last_message: string | null
    message_updated: number | null
    parts: number
    part_updated: number | null
  }>
  const out = new Map<string, SessionInfo>()
  for (const r of rows) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([r.title, r.time_archived, r.messages, r.last_message, r.message_updated, r.parts, r.part_updated]))
      .digest("hex")
    const updatedAt = Math.max(Number(r.time_updated), Number(r.message_updated ?? 0), Number(r.part_updated ?? 0))
    out.set(r.id, { id: r.id, title: r.title, updatedAt, messages: Number(r.messages), fingerprint })
  }
  return out
}

export interface SessionConflict {
  id: string
  title: string
  localUpdatedAt: number
  incomingUpdatedAt: number
  localMessages: number
  incomingMessages: number
}

/** Sessions present on both devices whose content differs. Identical ones are skipped silently. */
export function sessionConflicts(local: Map<string, SessionInfo>, incoming: Map<string, SessionInfo>): SessionConflict[] {
  const out: SessionConflict[] = []
  for (const [id, inc] of incoming) {
    const mine = local.get(id)
    if (!mine || mine.fingerprint === inc.fingerprint) continue
    out.push({
      id,
      title: inc.title || mine.title,
      localUpdatedAt: mine.updatedAt,
      incomingUpdatedAt: inc.updatedAt,
      localMessages: mine.messages,
      incomingMessages: inc.messages,
    })
  }
  return out
}

/** Projects present on both devices (shown as "the source version is used"). */
export function sharedProjects(db: SqlHandle, incomingSchema: string): number {
  const row = db
    .prepare(`SELECT count(*) AS n FROM ${incomingSchema}.project i JOIN main.project l ON l.id = i.id`)
    .get() as { n: number }
  return Number(row.n)
}

export interface MergePlan {
  /** Top-level session ids whose incoming version replaces the local one. */
  overwrite: readonly string[]
  /** Absolute path prefix rewrites applied to directories and JSON message / part data. */
  rewrite?: { from: string; to: string }
}

export interface MergeResult {
  imported: number
  overwritten: number
  skipped: number
}

/** Session ids including every descendant session (parent_id chain). */
function withDescendants(db: SqlHandle, schema: string, roots: string[]): string[] {
  if (roots.length === 0) return []
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS mig_roots (id text PRIMARY KEY)`)
  db.exec(`DELETE FROM mig_roots`)
  const insert = db.prepare(`INSERT OR IGNORE INTO mig_roots (id) VALUES (?)`)
  for (const id of roots) insert.run(id)
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT id FROM mig_roots
         UNION SELECT s.id FROM ${schema}.session s JOIN tree t ON s.parent_id = t.id)
       SELECT id FROM tree`,
    )
    .all() as { id: string }[]
  return rows.map((r) => r.id)
}

function rewriteExpr(column: string, rewrite?: { from: string; to: string }): string {
  if (!rewrite || rewrite.from === rewrite.to) return column
  // JSON text escapes backslashes (Windows paths), so rewrite both the raw and the escaped form.
  const esc = (s: string) => s.replaceAll("\\", "\\\\")
  const lit = (s: string) => `'${s.replaceAll("'", "''")}'`
  let expr = `replace(${column}, ${lit(rewrite.from)}, ${lit(rewrite.to)})`
  if (esc(rewrite.from) !== rewrite.from) expr = `replace(${expr}, ${lit(esc(rewrite.from))}, ${lit(esc(rewrite.to))})`
  return expr
}

const REWRITE_COLUMNS: Record<string, readonly string[]> = {
  session: ["directory"],
  message: ["data"],
  part: ["data"],
  project: ["worktree", "sandboxes"],
  workspace: ["directory"],
}

/**
 * Merge the attached incoming database (schema `incoming`) into main in one transaction.
 * The caller attaches it first: `ATTACH DATABASE '<path>' AS incoming`.
 */
export function merge(db: SqlHandle, plan: MergePlan, incoming = "incoming"): MergeResult {
  const localVersion = schemaVersion(db)
  const incomingVersion = schemaVersion(db, incoming)
  if (incomingVersion > localVersion) throw new MigrationEngineVersionError(incomingVersion, localVersion)

  const localIds = new Set((db.prepare(`SELECT id FROM main.session WHERE parent_id IS NULL`).all() as { id: string }[]).map((r) => r.id))
  const incomingRoots = (db.prepare(`SELECT id FROM ${incoming}.session WHERE parent_id IS NULL`).all() as { id: string }[]).map((r) => r.id)
  const overwrite = new Set(plan.overwrite.filter((id) => localIds.has(id)))
  const roots = incomingRoots.filter((id) => !localIds.has(id) || overwrite.has(id))

  db.exec("BEGIN IMMEDIATE")
  try {
    // 1. Remove overwritten sessions (with descendants) from main.
    const doomed = withDescendants(db, "main", [...overwrite])
    if (doomed.length > 0) {
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS mig_doomed (id text PRIMARY KEY)`)
      db.exec(`DELETE FROM mig_doomed`)
      const ins = db.prepare(`INSERT OR IGNORE INTO mig_doomed (id) VALUES (?)`)
      for (const id of doomed) ins.run(id)
      for (const table of UNCASCADED) {
        if (!hasTable(db, "main", table)) continue
        const column = table === "inbox" ? "receiver_session_id" : "session_id"
        db.exec(`DELETE FROM main.${quote(table)} WHERE ${quote(column)} IN (SELECT id FROM mig_doomed)`)
      }
      db.exec(`DELETE FROM main.session WHERE id IN (SELECT id FROM mig_doomed)`)
    }

    // 2. Sessions to import: incoming roots not kept locally, plus their descendants.
    const ids = withDescendants(db, incoming, roots)
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS mig_ids (id text PRIMARY KEY)`)
    db.exec(`DELETE FROM mig_ids`)
    const insId = db.prepare(`INSERT OR IGNORE INTO mig_ids (id) VALUES (?)`)
    for (const id of ids) insId.run(id)

    // 3. Projects and workspaces referenced by imported sessions; same id → incoming wins, in place.
    for (const table of ["project", "workspace"]) {
      if (!hasTable(db, "main", table) || !hasTable(db, incoming, table)) continue
      const shared = columns(db, incoming, table).filter((c) => columns(db, "main", table).includes(c))
      const select = shared.map((c) => (REWRITE_COLUMNS[table]?.includes(c) ? rewriteExpr(quote(c), plan.rewrite) : quote(c)))
      const filter =
        table === "project"
          ? `id IN (SELECT project_id FROM ${incoming}.session WHERE id IN (SELECT id FROM mig_ids))`
          : `project_id IN (SELECT project_id FROM ${incoming}.session WHERE id IN (SELECT id FROM mig_ids))`
      const updates = shared.filter((c) => c !== "id").map((c) => `${quote(c)} = excluded.${quote(c)}`)
      db.exec(
        `INSERT INTO main.${quote(table)} (${shared.map(quote).join(", ")})
         SELECT ${select.join(", ")} FROM ${incoming}.${quote(table)} WHERE ${filter}
         ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`,
      )
    }

    // 4. Session-keyed tables, shared columns only.
    for (const { table, column, skip } of SESSION_TABLES) {
      if (!hasTable(db, "main", table) || !hasTable(db, incoming, table)) continue
      const mine = columns(db, "main", table)
      const shared = columns(db, incoming, table).filter((c) => mine.includes(c) && !skip?.includes(c))
      const select = shared.map((c) => (REWRITE_COLUMNS[table]?.includes(c) ? rewriteExpr(quote(c), plan.rewrite) : quote(c)))
      db.exec(
        `INSERT OR IGNORE INTO main.${quote(table)} (${shared.map(quote).join(", ")})
         SELECT ${select.join(", ")} FROM ${incoming}.${quote(table)} WHERE ${quote(column)} IN (SELECT id FROM mig_ids)`,
      )
    }
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
  return { imported: roots.length - overwrite.size, overwritten: overwrite.size, skipped: incomingRoots.length - roots.length }
}

/**
 * Re-home every session of project `from` onto project `to` (re-pointing a migrated project
 * at a folder this device already uses). The emptied project row is removed.
 */
export function rebindProject(db: SqlHandle, from: string, to: string): number {
  if (from === to) return 0
  db.exec("BEGIN IMMEDIATE")
  try {
    const moved = db.prepare(`UPDATE main.session SET project_id = ? WHERE project_id = ?`).run(to, from) as { changes?: number }
    if (hasTable(db, "main", "history_fts")) db.prepare(`UPDATE main.history_fts SET project_id = ? WHERE project_id = ?`).run(to, from)
    if (hasTable(db, "main", "workspace")) db.prepare(`UPDATE main.workspace SET project_id = ? WHERE project_id = ?`).run(to, from)
    db.prepare(`DELETE FROM main.project WHERE id = ? AND NOT EXISTS (SELECT 1 FROM main.session WHERE project_id = ?)`).run(from, from)
    db.exec("COMMIT")
    return Number(moved?.changes ?? 0)
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}
