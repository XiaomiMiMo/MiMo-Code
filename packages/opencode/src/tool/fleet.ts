import type { Actor, Liveness } from "@/actor/schema"
import { deriveLiveness } from "@/actor/schema"

// Fleet observability: assemble a single structured view of an Orchestrator's
// children — each session correlated to (a) its derived liveness and turn
// telemetry, and (b) the git worktree backing it (dir + branch + commits-ahead)
// for isolated children. This is the data layer T39's `session list` never
// exposed: the worktree/branch mapping was invisible, and liveness was a flat
// text dump. assembleFleet + renderFleetTable are PURE (no Effect, no git, no
// clock) so the assembly logic is unit-testable in isolation; the tool wires in
// the live sessions / actor registry / `git worktree list` at call time.

// A single child session as the caller sees it before correlation. Mirrors the
// subset of Session.Info the fleet cares about.
export interface FleetSession {
  id: string
  title: string
  directory: string
}

// One parsed `git worktree list --porcelain` entry, canonicalized so it can be
// matched against a session's directory by exact string equality.
export interface WorktreeEntry {
  // Canonical (realpath-resolved, normalized) worktree directory.
  directory: string
  // Short branch name (refs/heads/ stripped), or undefined for a detached HEAD.
  branch?: string
  // Commits this worktree's branch is ahead of the repo's base — undefined when
  // it could not be computed (non-git, detached, or rev-list failed).
  ahead?: number
}

// The display bucket a child falls into. progressing/stalled come from
// deriveLiveness on a running/pending row; idle/failed/cancelled are terminal.
export type FleetBucket = "progressing" | "stalled" | "idle" | "failed" | "cancelled"

// One fully-correlated row: session identity + liveness + turn telemetry +
// (optional) worktree mapping.
export interface FleetRow {
  sessionID: string
  title: string
  mode: string
  bucket: FleetBucket
  liveness: Liveness
  status: string
  turnCount: number
  // ms since the last turn advanced; undefined when there is no actor row.
  lastActivityMs?: number
  // Worktree correlation — present only for isolated children whose directory
  // matched a `git worktree list` entry.
  worktreeDir?: string
  branch?: string
  ahead?: number
}

export interface FleetSummary {
  total: number
  counts: Record<FleetBucket, number>
  rows: FleetRow[]
}

// An actor row keyed to its session, or null when no actor is registered for
// that child (a plain idle session that never spawned an actor).
export interface FleetActorInput {
  session: FleetSession
  actor: Actor | null
}

function bucketFor(liveness: Liveness): FleetBucket {
  if (liveness === "progressing") return "progressing"
  if (liveness === "stalled") return "stalled"
  if (liveness === "failure") return "failed"
  if (liveness === "cancelled") return "cancelled"
  return "idle"
}

// Assemble the structured fleet summary from already-fetched inputs. Pure: the
// caller supplies the sessions+actors (from Session.children + ActorRegistry),
// the worktree entries (from `git worktree list --porcelain` + rev-list), and
// the clock (`now`) + staleness window so tests are deterministic.
//
// Worktree correlation is a plain directory-equality lookup: a child is
// "isolated" iff its session.directory matches a worktree entry's directory.
// Shared-dir children simply carry no worktree fields. Rows are grouped by
// bucket in a fixed order (progressing → stalled → idle → failed → cancelled)
// so the rendered table reads top-down from most-active to terminal.
export function assembleFleet(
  inputs: FleetActorInput[],
  worktrees: WorktreeEntry[],
  now: number,
  stallMs?: number,
): FleetSummary {
  const byDir = new Map<string, WorktreeEntry>()
  for (const wt of worktrees) byDir.set(wt.directory, wt)

  const rows = inputs.map(({ session, actor }): FleetRow => {
    const liveness = actor ? deriveLiveness(actor, now, stallMs) : ("idle" as Liveness)
    const wt = byDir.get(session.directory)
    return {
      sessionID: session.id,
      title: session.title,
      mode: actor?.agent ?? "?",
      bucket: bucketFor(liveness),
      liveness,
      status: actor?.status ?? "unknown",
      turnCount: actor?.turnCount ?? 0,
      ...(actor ? { lastActivityMs: Math.max(0, now - actor.lastTurnTime) } : {}),
      ...(wt ? { worktreeDir: wt.directory, branch: wt.branch, ahead: wt.ahead } : {}),
    }
  })

  const order: FleetBucket[] = ["progressing", "stalled", "idle", "failed", "cancelled"]
  const rank = (b: FleetBucket) => order.indexOf(b)
  const sorted = [...rows].sort((a, b) => rank(a.bucket) - rank(b.bucket))

  const counts: Record<FleetBucket, number> = {
    progressing: 0,
    stalled: 0,
    idle: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const r of sorted) counts[r.bucket]++

  return { total: sorted.length, counts, rows: sorted }
}

// Compact human age: "-" when unknown, "<Ns>" under a minute, else "<Nm>"/"<Nh>".
function ageOf(ms: number | undefined): string {
  if (ms === undefined) return "-"
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

// A short worktree cell: "branch (+N) @ dir" for isolated children, "shared"
// otherwise. Kept as one column so the table stays narrow in a terminal.
function worktreeCell(r: FleetRow): string {
  if (!r.worktreeDir) return "shared"
  const branch = r.branch ?? "detached"
  const ahead = r.ahead === undefined ? "" : ` (+${r.ahead})`
  return `${branch}${ahead} @ ${r.worktreeDir}`
}

const HEADINGS: Record<FleetBucket, string> = {
  progressing: "In progress — progressing (advancing)",
  stalled: "In progress — stalled (no recent turn)",
  idle: "Finished / idle",
  failed: "Failed",
  cancelled: "Cancelled",
}

// Render the fleet summary as a grouped, column-aligned text table. Pure over
// the summary produced by assembleFleet. One block per non-empty bucket; each
// row shows session id, liveness+age, turns, mode, worktree mapping, and title.
export function renderFleetTable(summary: FleetSummary): string {
  if (summary.total === 0) return "No child sessions."

  const c = summary.counts
  const running = c.progressing + c.stalled
  const summaryLine =
    `Fleet: ${summary.total} total — ${running} running ` +
    `(${c.progressing} progressing, ${c.stalled} stalled), ${c.idle} idle` +
    (c.failed > 0 ? `, ${c.failed} failed` : "") +
    (c.cancelled > 0 ? `, ${c.cancelled} cancelled` : "")

  const cols = ["SESSION", "LIVENESS", "AGE", "TURNS", "MODE", "WORKTREE", "TITLE"]
  const allRows = summary.rows.map((r) => [
    r.sessionID,
    r.liveness,
    ageOf(r.lastActivityMs),
    String(r.turnCount),
    r.mode,
    worktreeCell(r),
    r.title,
  ])

  // Column widths sized across ALL rows so blocks align with each other.
  const widths = cols.map((h, i) => Math.max(h.length, ...allRows.map((row) => row[i].length)))
  const pad = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()

  const order: FleetBucket[] = ["progressing", "stalled", "idle", "failed", "cancelled"]
  const blocks = order
    .filter((b) => c[b] > 0)
    .map((b) => {
      const bodyRows = summary.rows
        .map((r, i) => ({ r, cells: allRows[i] }))
        .filter(({ r }) => r.bucket === b)
        .map(({ cells }) => "  " + pad(cells))
      return `${HEADINGS[b]} (${c[b]}):\n${bodyRows.join("\n")}`
    })

  return [summaryLine, "", "  " + pad(cols), ...blocks].join("\n")
}
