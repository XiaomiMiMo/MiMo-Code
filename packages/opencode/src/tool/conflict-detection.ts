import { Database, eq } from "@/storage"
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
    const dotGit = path.join(directory, ".git")
    if (!fs.existsSync(dotGit)) return null
    const stat = fs.statSync(dotGit)
    if (stat.isDirectory()) return dotGit
    const content = fs.readFileSync(dotGit, "utf-8").trim()
    const match = content.match(/^gitdir:\s*(.+)$/)
    if (!match) return null
    const gitDir = path.resolve(path.dirname(dotGit), match[1].trim())
    return fs.existsSync(gitDir) ? gitDir : null
  } catch {
    return null
  }
}

function hasActiveSessionsInDirectory(directory: string, excludeSessionId?: string): string | null {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
  const sessions = Database.use((db) =>
    db.select({ id: SessionTable.id, time_updated: SessionTable.time_updated })
      .from(SessionTable)
      .where(eq(SessionTable.directory, directory))
      .all(),
  )
  for (const session of sessions) {
    if (session.id === excludeSessionId) continue
    if (session.time_updated > fiveMinutesAgo) return session.id
  }
  return null
}

function hasGitLock(directory: string): boolean {
  try {
    const gitDir = resolveGitDir(directory)
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
  // Quick exit: not a git repo → no conflict possible
  if (!resolveGitDir(directory)) return { hasConflict: false, reason: null }
  const activeSessionId = hasActiveSessionsInDirectory(directory, newSessionId)
  if (activeSessionId) return { hasConflict: true, reason: "active-session", activeSessionId }
  if (hasGitLock(directory)) return { hasConflict: true, reason: "git-lock" }
  if (await hasExternalAgentProcess(directory)) return { hasConflict: true, reason: "external-process" }
  return { hasConflict: false, reason: null }
}
