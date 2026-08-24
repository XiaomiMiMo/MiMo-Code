import { Database, eq, and } from "@/storage"
import { SessionTable } from "@/session/session.sql"
import { Global } from "@/global"
import path from "path"
import fs from "fs"
import { execSync } from "child_process"

/**
 * Conflict detection for auto-worktree.
 *
 * Detects when a new session should create a worktree because:
 * 1. Another mimocode session is actively running in the same directory
 * 2. There are uncommitted git changes (suggesting external agent activity)
 */

export interface ConflictResult {
  hasConflict: boolean
  reason: "active-session" | "uncommitted-changes" | "git-lock" | "external-process" | null
  activeSessionId?: string
}

/**
 * Check if there are active sessions in the given directory.
 * An active session is one that has a running harness execution.
 * We approximate this by checking if the session was updated recently (within 5 minutes).
 */
function hasActiveSessionsInDirectory(directory: string, excludeSessionId?: string): string | null {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
  
  const sessions = Database.use((db) =>
    db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.directory, directory))
      .all(),
  )
  
  // Check if any session was updated recently (proxy for active)
  for (const session of sessions) {
    // Skip the session we're creating
    if (session.id === excludeSessionId) continue
    
    const fullSession = Database.use((db) =>
      db
        .select({ time_updated: SessionTable.time_updated })
        .from(SessionTable)
        .where(eq(SessionTable.id, session.id))
        .get(),
    )
    
    if (fullSession && fullSession.time_updated > fiveMinutesAgo) {
      return session.id
    }
  }
  
  return null
}

/**
 * Check for git lock files (indicates git operation in progress).
 */
function hasGitLock(directory: string): boolean {
  try {
    const gitDir = path.join(directory, ".git")
    if (!fs.existsSync(gitDir)) return false
    const lockFile = path.join(gitDir, "index.lock")
    return fs.existsSync(lockFile)
  } catch {
    return false
  }
}

/**
 * Check if there are uncommitted git changes in the directory.
 * This suggests external agent activity.
 */
function hasUncommittedChanges(directory: string): boolean {
  try {
    const gitDir = path.join(directory, ".git")
    if (!fs.existsSync(gitDir)) return false
    
    const status = execSync("git status --porcelain", { 
      cwd: directory, 
      encoding: "utf-8",
      timeout: 5000,
    }).trim()
    
    return status.length > 0
  } catch {
    return false
  }
}

/**
 * Check if known external agent processes are running in the directory.
 * Detects Claude Code, Cursor, Copilot, and other common AI coding tools.
 */
function hasExternalAgentProcess(directory: string): boolean {
  try {
    const normalizedDir = path.resolve(directory)
    
    // Check for known agent processes (based on OpenRouter app rankings)
    const agentPatterns = [
      "claude",       // Claude Code (685B tokens)
      "kilocode",     // Kilo Code (401B tokens)
      "cline",        // Cline (297B tokens)
      "codex",        // Codex (123B tokens)
      "cursor",       // Cursor (64.7B tokens)
      "omp",          // omp (343B tokens)
      "openclaw",     // OpenClaw (140B tokens)
      "pi.dev",       // pi (258B tokens)
      "zcode",        // ZCode (143B tokens)
    ]
    
    // Platform-specific process detection with directory check
    let processOutput: string
    if (process.platform === "win32") {
      // Windows: use wmic to list processes (can't easily check open files without handle.exe)
      // Fall back to process name matching only
      processOutput = execSync(
        "wmic process get Name,CommandLine /FORMAT:LIST",
        { encoding: "utf-8", timeout: 10000 },
      )
    } else {
      // Linux/macOS: use lsof to find processes with open files in the target directory
      processOutput = execSync(
        `lsof +D ${normalizedDir} 2>/dev/null | head -100`,
        { encoding: "utf-8", timeout: 10000 },
      )
    }
    
    if (!processOutput.trim()) return false
    
    // Check if any of the processes with open files match our agent patterns
    const lowerOutput = processOutput.toLowerCase()
    for (const pattern of agentPatterns) {
      if (lowerOutput.includes(pattern)) {
        return true
      }
    }
    
    return false
  } catch {
    return false
  }
}

/**
 * Check if a worktree should be created for a new session.
 * Returns conflict information if detected.
 */
export function checkConflict(directory: string, newSessionId?: string): ConflictResult {
  // Signal 1: Check for active mimocode sessions
  const activeSessionId = hasActiveSessionsInDirectory(directory, newSessionId)
  if (activeSessionId) {
    return {
      hasConflict: true,
      reason: "active-session",
      activeSessionId,
    }
  }
  
  // Signal 2: Check for git lock (git operation in progress)
  if (hasGitLock(directory)) {
    return {
      hasConflict: true,
      reason: "git-lock",
    }
  }
  
  // Signal 3: Check for uncommitted changes (external agent)
  if (hasUncommittedChanges(directory)) {
    return {
      hasConflict: true,
      reason: "uncommitted-changes",
    }
  }
  
  // Signal 4: Check for external agent processes
  if (hasExternalAgentProcess(directory)) {
    return {
      hasConflict: true,
      reason: "external-process",
    }
  }
  
  return {
    hasConflict: false,
    reason: null,
  }
}
