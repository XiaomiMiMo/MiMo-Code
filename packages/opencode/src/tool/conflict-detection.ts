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

function resolveGitDir(directory: string): string | null {
  try {
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
  } catch {
    return null
  }
}

function hasActiveSessionsInDirectory(directory: string, excludeSessionId?: string): string | null {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
  const sessions = Database.use((db) =>
    db.select({ id: SessionTable.id, time_updated: SessionTable.time_updated })
      .from(SessionTable)
      .where(and(
        eq(SessionTable.directory, directory),
        isNull(SessionTable.time_archived),
        gte(SessionTable.time_updated, fiveMinutesAgo),
      ))
      .all(),
  )
  const session = sessions.find((s) => s.id !== excludeSessionId)
  if (session) return session.id
  return null
}

function hasGitLock(gitDir: string | null): boolean {
  try {
    if (!gitDir) return false
    return fs.existsSync(path.join(gitDir, "index.lock"))
  } catch {
    return false
  }
}

async function hasExternalAgentProcess(directory: string): Promise<boolean> {
  // Patterns must match real command names in ps -o comm= output.
  // Removed: cline (VSCode extension, no separate process), omp/pi (no known CLI binary).
  const agentPatterns = ["claude", "kilocode", "codex", "cursor"]
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("wmic", ["process", "get", "Name", "/FORMAT:LIST"], { timeout: 10000 })
      return agentPatterns.some((p) => stdout.toLowerCase().includes(p))
    }
    const { stdout } = await execFileAsync("lsof", ["-t", "+D", directory], { timeout: 10000 })
    const pids = stdout.trim().split("\n").filter(Boolean)
    for (const pid of pids.slice(0, 50)) {
      try {
        const { stdout: cmd } = await execFileAsync("ps", ["-p", pid, "-o", "comm="], { timeout: 3000 })
        if (agentPatterns.some((p) => cmd.trim().toLowerCase().includes(p))) return true
      } catch { continue }
    }
    return false
  } catch {
    return false
  }
}

export async function checkConflict(directory: string, newSessionId?: string): Promise<ConflictResult> {
  const gitDir = resolveGitDir(directory)
  if (!gitDir) return { hasConflict: false, reason: null }
  const activeSessionId = hasActiveSessionsInDirectory(directory, newSessionId)
  if (activeSessionId) return { hasConflict: true, reason: "active-session", activeSessionId }
  if (hasGitLock(gitDir)) return { hasConflict: true, reason: "git-lock" }
  if (await hasExternalAgentProcess(directory)) return { hasConflict: true, reason: "external-process" }
  return { hasConflict: false, reason: null }
}
