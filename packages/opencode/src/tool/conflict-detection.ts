import { Database, eq, and, isNull, gte } from "@/storage"
import { SessionTable } from "@/session/session.sql"
import path from "path"
import fs from "fs"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export interface ConflictResult {
  hasConflict: boolean
  reason: "active-session" | "git-lock" | "external-process" | null
  activeSessionId?: string
}

/**
 * Resolve the .git directory, walking up from the given directory.
 * Handles both main worktrees (.git is a directory) and linked worktrees (.git is a file).
 */
function resolveGitDir(directory: string): string | null {
  let dir = path.resolve(directory)
  while (true) {
    const dotGit = path.join(dir, ".git")
    if (fs.existsSync(dotGit)) {
      const stat = fs.statSync(dotGit)
      if (stat.isDirectory()) return dotGit
      const content = fs.readFileSync(dotGit, "utf-8").trim()
      const match = content.match(/^gitdir:\s*(.+)$/)
      if (!match) return null
      const gitDir = path.resolve(path.dirname(dotGit), match[1].trim())
      return fs.existsSync(gitDir) ? gitDir : null
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Check for active sessions in the directory (updated within last 5 minutes, not archived).
 * Returns the session ID of the first active session found, or null.
 */
function hasActiveSessionsInDirectory(directory: string, excludeSessionId?: string): string | null {
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
  return sessions.find((s) => s.id !== excludeSessionId)?.id ?? null
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
  const agentPatterns = ["claude", "codex", "cursor"]

  if (process.platform === "win32") {
    // Windows: wmic lists all processes, match by name
    const { stdout } = await execFileAsync("wmic", ["process", "get", "Name", "/FORMAT:LIST"], { timeout: 10000 })
    return agentPatterns.some((p) => stdout.toLowerCase().includes(p))
  }

  // Linux/macOS: lsof finds processes with open files in directory, then check command name
  const { stdout } = await execFileAsync("lsof", ["-t", "+D", directory], { timeout: 10000 })
  const pids = stdout.trim().split("\n").filter(Boolean)

  for (const pid of pids) {
    try {
      const { stdout: cmd } = await execFileAsync("ps", ["-p", pid, "-o", "comm="], { timeout: 3000 })
      if (agentPatterns.some((p) => cmd.trim().toLowerCase().includes(p))) return true
    } catch {
      // Process may have exited between lsof and ps - skip
    }
  }

  return false
}

/**
 * Check if a worktree should be created for a new session.
 * Returns conflict information if detected.
 */
export async function checkConflict(directory: string, newSessionId?: string): Promise<ConflictResult> {
  const gitDir = resolveGitDir(directory)
  if (!gitDir) return { hasConflict: false, reason: null }

  // Signal 1: Active sessions in same directory
  const activeSessionId = hasActiveSessionsInDirectory(directory, newSessionId)
  if (activeSessionId) return { hasConflict: true, reason: "active-session", activeSessionId }

  // Signal 2: Git lock file
  if (hasGitLock(gitDir)) return { hasConflict: true, reason: "git-lock" }

  // Signal 3: External agent processes
  if (await hasExternalAgentProcess(directory)) return { hasConflict: true, reason: "external-process" }

  return { hasConflict: false, reason: null }
}
