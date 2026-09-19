import fs from "fs/promises"
import path from "path"
import { checkpointPath, tasksDir } from "./checkpoint-paths"
import type { SessionID } from "./schema"
import { Log } from "../util"

const log = Log.create({ service: "session.progress-reconcile" })

export interface ProgressDiffItem {
  taskId: string
  writtenAt: number
  status: "NEW" | "CHANGED"
  prior?: number
}

// Parse written-at field from markdown frontmatter
// Returns null when frontmatter or field is absent
export function parseWrittenAt(body: string): number | null {
  const fm = body.match(/^---\n([\s\S]*?)\n---\n/)
  if (!fm) return null
  const line = fm[1].split("\n").find((l) => l.startsWith("written-at:"))
  if (!line) return null
  const value = Number(line.slice("written-at:".length).trim())
  if (!Number.isFinite(value)) return null
  return value
}

// Parse main checkpoint.md for last-reconciled-written-at markers
// Returns Map of task ID to reconciled timestamp
export function parseReconciledMap(mainCheckpoint: string): Map<string, number> {
  const map = new Map<string, number>()
  // Negative lookbehind on backtick avoids matching a marker quoted inside a
  // code span (blast radius is tiny — at most one missed reconcile round — but
  // cheap to harden).
  const re = /(?<!`)\(progress:\s*tasks\/([^/]+)\/progress\.md,\s*last-reconciled-written-at:\s*(\d+)\)/g
  for (const m of mainCheckpoint.matchAll(re)) {
    const value = Number(m[2])
    if (Number.isFinite(value)) map.set(m[1], value)
  }
  return map
}

// Scan tasks/*/progress.md and compare written-at against prior reconciliation
// Returns NEW and CHANGED items; UNCHANGED and unparseable files are omitted
export async function buildProgressDiffItems(sessionID: SessionID): Promise<ProgressDiffItem[]> {
  const main = await Bun.file(checkpointPath(sessionID)).text().catch(() => "")
  const reconciled = parseReconciledMap(main)

  const root = tasksDir(sessionID)
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }

  const items: ProgressDiffItem[] = []
  for (const entry of entries) {
    const fp = path.join(root, entry, "progress.md")
    let body: string
    try {
      body = await Bun.file(fp).text()
    } catch {
      continue
    }
    const writtenAt = parseWrittenAt(body)
    if (writtenAt === null) continue // no written-at marker (e.g. subagent write incomplete); skip

    const prior = reconciled.get(entry)
    if (prior === undefined) {
      items.push({ taskId: entry, writtenAt, status: "NEW" })
    } else if (writtenAt > prior) {
      items.push({ taskId: entry, writtenAt, status: "CHANGED", prior })
    }
    // else UNCHANGED: skip
  }

  return items
}

// Render markdown injection block for writer prompt
// Returns empty string when there are no NEW/CHANGED items
export function renderProgressDiffBlock(items: ProgressDiffItem[]): string {
  if (items.length === 0) return ""
  const lines = ["SUBAGENT PROGRESS to integrate (since last reconcile):"]
  for (const it of items) {
    if (it.status === "NEW") {
      lines.push(`  - ${it.taskId} (NEW, written-at=${it.writtenAt})`)
    } else {
      lines.push(`  - ${it.taskId} (CHANGED, written-at=${it.writtenAt}, prior=${it.prior})`)
    }
  }
  lines.push("")
  lines.push(
    "For each: Read tasks/<TID>/progress.md, integrate §4 (verbatim commands) verbatim into main §5 Current work; integrate §5 (outcome+discoveries) into main §5 or §7 as appropriate. Then update the corresponding §4 line in main checkpoint to:",
  )
  lines.push(
    "  (progress: tasks/<TID>/progress.md, last-reconciled-written-at: <written-at from above>)",
  )
  return lines.join("\n")
}

// High-level convenience: scan + render in one call
// Returns empty string when nothing to reconcile
export async function buildProgressDiff(sessionID: SessionID): Promise<string> {
  const items = await buildProgressDiffItems(sessionID).catch((err) => {
    log.warn("buildProgressDiff failed; reconcile skipped this turn", { err, sessionID })
    return [] as ProgressDiffItem[]
  })
  return renderProgressDiffBlock(items)
}
