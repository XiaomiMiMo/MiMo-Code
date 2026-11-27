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
// - Projects referenced by incoming sessions are inserted, or updated in place (ON CONFLICT DO
//   UPDATE) unless the user kept the local version. Never INSERT OR REPLACE: REPLACE deletes first
//   and the session foreign key cascades away local sessions.
// - Paths are rewritten by a caller-provided function, only in rows this merge writes, so local and
//   kept rows never change. The caller owns the path forms (raw, JSON-escaped, file:// URLs).
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

/** Projects present on both devices whose user-visible info differs (the incoming worktree compared after rewrite). */
export interface ProjectConflict {
  id: string
  name: string
  localName: string
  incomingName: string
  localWorktree: string
  incomingWorktree: string
  localUpdatedAt: number
  incomingUpdatedAt: number
}

type ProjectRow = {
  id: string
  worktree: string
  name: string | null
  icon_url: string | null
  icon_color: string | null
  commands: string | null
  time_updated: number
}

function projectRows(db: SqlHandle, schema: string): Map<string, ProjectRow> {
  if (!hasTable(db, schema, "project")) return new Map()
  const have = columns(db, schema, "project")
  const col = (c: string) => (have.includes(c) ? quote(c) : `NULL AS ${quote(c)}`)
  const rows = db
    .prepare(`SELECT id, worktree, ${col("name")}, ${col("icon_url")}, ${col("icon_color")}, ${col("commands")}, time_updated FROM ${schema}.project`)
    .all() as ProjectRow[]
  return new Map(rows.map((r) => [r.id, r]))
}

/**
 * Projects referenced by incoming sessions that also exist locally with different name, icon,
 * commands or worktree. Identical ones (and projects only on one device) are not listed.
 */
export function projectConflicts(db: SqlHandle, incomingSchema: string, rewrite?: (text: string) => string): ProjectConflict[] {
  const local = projectRows(db, "main")
  const incoming = projectRows(db, incomingSchema)
  const used = new Set(
    (db.prepare(`SELECT DISTINCT project_id AS id FROM ${incomingSchema}.session`).all() as { id: string }[]).map((r) => r.id),
  )
  const out: ProjectConflict[] = []
  for (const [id, inc] of incoming) {
    const mine = local.get(id)
    if (!mine || !used.has(id)) continue
    const incWorktree = rewrite ? rewrite(inc.worktree) : inc.worktree
    const same =
      (mine.name ?? "") === (inc.name ?? "") &&
      (mine.icon_url ?? "") === (inc.icon_url ?? "") &&
      (mine.icon_color ?? "") === (inc.icon_color ?? "") &&
      (mine.commands ?? "") === (inc.commands ?? "") &&
      mine.worktree === incWorktree
    if (same) continue
    out.push({
      id,
      name: inc.name || mine.name || incWorktree,
      localName: mine.name ?? "",
      incomingName: inc.name ?? "",
      localWorktree: mine.worktree,
      incomingWorktree: incWorktree,
      localUpdatedAt: Number(mine.time_updated),
      incomingUpdatedAt: Number(inc.time_updated),
    })
  }
  return out
}

/** Text columns that may hold local file paths: scanned on export, rewritten for imported rows. */
export const PATH_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session: ["directory"],
  message: ["data"],
  part: ["data"],
  project: ["worktree", "sandboxes"],
  workspace: ["directory"],
}

/** Distinct session directories and project roots (folders conversations run in). */
export function folderPaths(db: SqlHandle, schema = "main"): string[] {
  const out = new Set<string>()
  if (hasTable(db, schema, "session"))
    for (const r of db.prepare(`SELECT DISTINCT directory AS p FROM ${schema}.session`).all() as { p: string | null }[]) if (r.p) out.add(r.p)
  if (hasTable(db, schema, "project"))
    for (const r of db.prepare(`SELECT worktree AS p FROM ${schema}.project`).all() as { p: string | null }[]) if (r.p && r.p !== "/") out.add(r.p)
  return [...out]
}

const PAGE = 500

/** Visit every non-empty value of PATH_COLUMNS in `schema`, a page at a time (bounded memory). */
export function scanText(db: SqlHandle, schema: string, fn: (text: string, table: string, column: string) => void): void {
  for (const [table, cols] of Object.entries(PATH_COLUMNS)) {
    if (!hasTable(db, schema, table)) continue
    const have = columns(db, schema, table)
    const present = cols.filter((c) => have.includes(c))
    if (present.length === 0) continue
    const page = db.prepare(
      `SELECT rowid AS r, ${present.map(quote).join(", ")} FROM ${schema}.${quote(table)} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`,
    )
    let after = 0
    for (;;) {
      const rows = page.all(after) as Array<Record<string, unknown>>
      if (rows.length === 0) break
      for (const row of rows) {
        for (const c of present) {
          const v = row[c]
          if (typeof v === "string" && v) fn(v, table, c)
        }
      }
      after = Number(rows[rows.length - 1]!.r)
    }
  }
}

export interface MergePlan {
  /** Top-level session ids whose incoming version replaces the local one. */
  overwrite: readonly string[]
  /** Shared project ids whose local version is kept (incoming project row is not written). */
  keepProjects?: readonly string[]
  /** Rewrites local file paths inside the text of every row this merge writes. */
  rewrite?: (text: string) => string
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

function tempIds(db: SqlHandle, table: string, ids: Iterable<string>): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY)`)
  db.exec(`DELETE FROM ${table}`)
  const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (id) VALUES (?)`)
  for (const id of ids) ins.run(id)
}

/** Which rows of each PATH_COLUMNS table this merge wrote (and so may rewrite). */
const WRITTEN_ROWS: Record<string, string> = {
  session: `id IN (SELECT id FROM mig_ids)`,
  message: `session_id IN (SELECT id FROM mig_ids)`,
  part: `session_id IN (SELECT id FROM mig_ids)`,
  project: `id IN (SELECT id FROM mig_projects)`,
  workspace: `project_id IN (SELECT id FROM mig_projects)`,
}

/** Rewrite path text of the rows written by this merge, a page at a time, only updating changed rows. */
function rewriteWritten(db: SqlHandle, rewrite: (text: string) => string): void {
  for (const [table, cols] of Object.entries(PATH_COLUMNS)) {
    if (!hasTable(db, "main", table)) continue
    const have = columns(db, "main", table)
    const present = cols.filter((c) => have.includes(c))
    if (present.length === 0) continue
    const page = db.prepare(
      `SELECT rowid AS r, ${present.map(quote).join(", ")} FROM main.${quote(table)}
       WHERE rowid > ? AND ${WRITTEN_ROWS[table]} ORDER BY rowid LIMIT ${PAGE}`,
    )
    const update = db.prepare(`UPDATE main.${quote(table)} SET ${present.map((c) => `${quote(c)} = ?`).join(", ")} WHERE rowid = ?`)
    let after = 0
    for (;;) {
      const rows = page.all(after) as Array<Record<string, unknown>>
      if (rows.length === 0) break
      for (const row of rows) {
        let changed = false
        const values = present.map((c) => {
          const v = row[c]
          if (typeof v !== "string" || !v) return v
          const next = rewrite(v)
          if (next !== v) changed = true
          return next
        })
        if (changed) update.run(...values, row.r)
      }
      after = Number(rows[rows.length - 1]!.r)
    }
  }
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
      tempIds(db, "mig_doomed", doomed)
      for (const table of UNCASCADED) {
        if (!hasTable(db, "main", table)) continue
        const column = table === "inbox" ? "receiver_session_id" : "session_id"
        db.exec(`DELETE FROM main.${quote(table)} WHERE ${quote(column)} IN (SELECT id FROM mig_doomed)`)
      }
      db.exec(`DELETE FROM main.session WHERE id IN (SELECT id FROM mig_doomed)`)
    }

    // 2. Sessions to import: incoming roots not kept locally, plus their descendants.
    tempIds(db, "mig_ids", withDescendants(db, incoming, roots))

    // 3. Projects (and their workspaces) referenced by incoming sessions: new ones are inserted, shared
    //    ones are updated in place unless the user kept the local version.
    const keep = new Set(plan.keepProjects ?? [])
    const referenced = hasTable(db, incoming, "project")
      ? (db.prepare(`SELECT id FROM ${incoming}.project WHERE id IN (SELECT project_id FROM ${incoming}.session)`).all() as { id: string }[]).map((r) => r.id)
      : []
    tempIds(db, "mig_projects", referenced.filter((id) => !keep.has(id)))
    for (const table of ["project", "workspace"]) {
      if (!hasTable(db, "main", table) || !hasTable(db, incoming, table)) continue
      const shared = columns(db, incoming, table).filter((c) => columns(db, "main", table).includes(c))
      const filter = table === "project" ? `id IN (SELECT id FROM mig_projects)` : `project_id IN (SELECT id FROM mig_projects)`
      const updates = shared.filter((c) => c !== "id").map((c) => `${quote(c)} = excluded.${quote(c)}`)
      db.exec(
        `INSERT INTO main.${quote(table)} (${shared.map(quote).join(", ")})
         SELECT ${shared.map(quote).join(", ")} FROM ${incoming}.${quote(table)} WHERE ${filter}
         ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`,
      )
    }

    // 4. Session-keyed tables, shared columns only.
    for (const { table, column, skip } of SESSION_TABLES) {
      if (!hasTable(db, "main", table) || !hasTable(db, incoming, table)) continue
      const mine = columns(db, "main", table)
      const shared = columns(db, incoming, table).filter((c) => mine.includes(c) && !skip?.includes(c))
      db.exec(
        `INSERT OR IGNORE INTO main.${quote(table)} (${shared.map(quote).join(", ")})
         SELECT ${shared.map(quote).join(", ")} FROM ${incoming}.${quote(table)} WHERE ${quote(column)} IN (SELECT id FROM mig_ids)`,
      )
    }

    // 5. Point paths of the written rows at this device (local and kept rows are untouched).
    if (plan.rewrite) rewriteWritten(db, plan.rewrite)
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
