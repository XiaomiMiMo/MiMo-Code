import { Database, eq, and, isNull, gte } from "@/storage"
import { SessionTable } from "@/session/session.sql"
import path from "path"
import fs from "fs"
import { execFile } from "child_process"
import { promisify } from "util"
import { Log } from "@/util"
import { walkGitLayout } from "./auto-worktree-hint"

const execFileAsync = promisify(execFile)
const log = Log.create({ service: "conflict-detection" })

export interface ConflictResult {
  hasConflict: boolean
  reason: "active-session" | "git-lock" | "external-process" | null
  activeSessionId?: string
}

export type SessionQueryFn = (directory: string, excludeId?: string) => string | null

/**
 * Default session query: checks SessionTable for recently updated, non-archived sessions.
 * Can be replaced with a custom implementation for testing or alternative data sources.
 */
export function defaultSessionQuery(directory: string, excludeId?: string): string | null {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
  const sessions = Database.use((db) =>
    db.select({ id: SessionTable.id })
      .from(SessionTable)
      .where(and(
        eq(SessionTable.directory, directory),
        isNull(SessionTable.time_archived),
        gte(SessionTable.time_updated, fiveMinutesAgo),
      ))
      .all(),
  )
  return sessions.find((s) => s.id !== excludeId)?.id ?? null
}

/**
 * Resolve the .git directory via the shared git-layout walk.
 * Handles both main worktrees (.git is a directory) and linked worktrees (.git is a file).
 */
function resolveGitDir(directory: string): string | null {
  return walkGitLayout(directory)?.gitDir ?? null
}

/**
 * Check for git lock file (git operation in progress).
 */
function hasGitLock(gitDir: string): boolean {
  return fs.existsSync(path.join(gitDir, "index.lock"))
}

/**
 * Check if known external agent processes have open files in the directory.
 * Uses lsof (Linux/macOS) or wmic (Windows) to find processes, then matches command names.
 */
async function hasExternalAgentProcess(directory: string): Promise<boolean> {
  // Patterns match real command names in ps -o comm= output.
  // Only include tools with known CLI binaries (not VSCode extensions like Cline).
  // Use exact match to avoid loose .includes() false positives (e.g. "cursor" matching "mouse-cursor-daemon").
  const agentPatterns = ["claude", "codex", "cursor"]

  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("wmic", ["process", "get", "Name", "/FORMAT:LIST"], { timeout: 10000 })
      const cmds = stdout.toLowerCase().split("\n").map((c) => c.trim()).filter(Boolean)
      return agentPatterns.some((p) => cmds.some((c) => c === p || c.startsWith(p + ".") || c.startsWith(p + "-")))
    }

    const { stdout } = await execFileAsync("lsof", ["-t", "+D", directory], { timeout: 10000 })
    const pids = stdout.trim().split("\n").filter(Boolean)
    if (pids.length === 0) return false

    // Batch: single ps call for all PIDs instead of one-per-PID
    const { stdout: cmdOutput } = await execFileAsync("ps", ["-o", "comm=", "-p", pids.join(",")], { timeout: 5000 })
    const cmds = cmdOutput.toLowerCase().split("\n").map((c) => c.trim())
    return agentPatterns.some((p) => cmds.some((c) => c === p || c.startsWith(p + ".") || c.startsWith(p + "-")))
  } catch (err) {
    // Fail-open: lsof/wmic/ps unavailable (Alpine, Windows 24H2+, timeout) → no conflict detected
    log.debug("external process check failed", { error: String(err) })
    return false
  }
}

/**
 * Check if a worktree should be created for a new session.
 * Returns conflict information if detected.
 */
export async function checkConflict(
  directory: string,
  newSessionId?: string,
  sessionQuery?: SessionQueryFn,
): Promise<ConflictResult> {
  const gitDir = resolveGitDir(directory)
  if (!gitDir) return { hasConflict: false, reason: null }

  // Signal 1: Active sessions in same directory
  const queryFn = sessionQuery ?? defaultSessionQuery
  const activeSessionId = queryFn(directory, newSessionId)
  if (activeSessionId) return { hasConflict: true, reason: "active-session", activeSessionId }

  // Signal 2: Git lock file
  if (hasGitLock(gitDir)) return { hasConflict: true, reason: "git-lock" }

  // Signal 3: External agent processes
  if (await hasExternalAgentProcess(directory)) return { hasConflict: true, reason: "external-process" }

  return { hasConflict: false, reason: null }
}
