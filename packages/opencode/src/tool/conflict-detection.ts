import { Database, eq, and } from "@/storage"
import { SessionTable } from "@/session/session.sql"
import { Global } from "@/global"
import path from "path"
import fs from "fs"

/**
 * Conflict detection for auto-worktree.
 *
 * Detects when a new session should create a worktree because:
 * 1. Another mimocode session is actively running in the same directory
 * 2. There are uncommitted git changes (suggesting external agent activity)
 */

export interface ConflictResult {
  hasConflict: boolean
  reason: "active-session" | "uncommitted-changes" | null
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
 * Check if there are uncommitted git changes in the directory.
 * This suggests external agent activity (Claude Code, Cursor, etc.).
 */
function hasUncommittedChanges(directory: string): boolean {
  try {
    const gitDir = path.join(directory, ".git")
    if (!fs.existsSync(gitDir)) return false
    
    // Check for git lock files (indicates git operation in progress)
    const lockFile = path.join(gitDir, "index.lock")
    if (fs.existsSync(lockFile)) return true
    
    // Check for uncommitted changes using git status
    // This is a simplified check - in production, we'd use the git module
    const { execSync } = require("child_process")
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
  
  // Signal 2: Check for uncommitted changes (external agent)
  if (hasUncommittedChanges(directory)) {
    return {
      hasConflict: true,
      reason: "uncommitted-changes",
    }
  }
  
  return {
    hasConflict: false,
    reason: null,
  }
}
