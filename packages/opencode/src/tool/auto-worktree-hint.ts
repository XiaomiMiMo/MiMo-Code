import { Instance } from "@/project/instance"
import { Database, eq } from "@/storage"
import { SessionTable } from "@/session/session.sql"
import type { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import path from "path"
import fs from "fs"

export const AUTO_WORKTREE_NOTICE_MARKER = "Auto-Worktree Notice"

/** Tools whose successful completion mutates project files. */
const FILE_WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "multiedit", "notebook_edit"])

/**
 * Walk up from `startDir` and return the git MAIN worktree root, or null.
 * `.git` as a directory means a main worktree; `.git` as a `gitdir:` file means
 * a linked worktree (already isolated — not a hint target).
 */
export function findGitMainWorktree(startDir: string): string | null {
  try {
    let dir = path.resolve(startDir)
    for (;;) {
      const dotGit = path.join(dir, ".git")
      if (fs.existsSync(dotGit)) {
        const stat = fs.statSync(dotGit)
        return stat.isDirectory() ? dir : null
      }
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  } catch {
    return null
  }
}

export function isGitMainWorktree(startDir: string): boolean {
  return findGitMainWorktree(startDir) !== null
}

function resolveCandidate(target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(Instance.directory, target)
}

function toolInputString(part: MessageV2.Part, key: string): string | undefined {
  if (part.type !== "tool") return undefined
  const value = (part.state.input as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Scan the transcript for a completed write / bash mutate that landed in some
 * git MAIN worktree. Returns that worktree root (for the notice), or null.
 *
 * Deliberately path-based, not session-directory-based: a session bound to a
 * non-git scratch dir that `cd`s into another project's main checkout still
 * hits here. Isolated worktrees and non-git paths do not.
 */
export function sessionMutatedMainWorktree(messages: MessageV2.WithParts[]): string | null {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue

      if (FILE_WRITE_TOOLS.has(part.tool)) {
        const raw =
          toolInputString(part, "file_path") ??
          toolInputString(part, "notebook_path") ??
          // apply_patch has no single path; fall back to the session cwd
          (part.tool === "apply_patch" ? Instance.directory : undefined)
        if (!raw) continue
        const hit = findGitMainWorktree(resolveCandidate(raw))
        if (hit) return hit
        continue
      }

      if (part.tool === "bash") {
        const hits = part.state.metadata?.mainWorktreeHits
        if (Array.isArray(hits) && hits.length > 0 && typeof hits[0] === "string") return hits[0]
      }
    }
  }
  return null
}

export function isAutoWorktreeHintSent(sessionID: string): boolean {
  return Boolean(
    Database.use((db) =>
      db
        .select({ sent: SessionTable.auto_worktree_hint_sent })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID as SessionID))
        .get()?.sent,
    ),
  )
}

export function markAutoWorktreeHintSent(sessionID: string): void {
  Database.use((db) =>
    db
      .update(SessionTable)
      .set({ auto_worktree_hint_sent: true })
      .where(eq(SessionTable.id, sessionID as SessionID))
      .run(),
  )
}

export function hasAutoWorktreeNotice(message: MessageV2.WithParts): boolean {
  return message.parts.some(
    (part) =>
      part.type === "text" && part.synthetic && !part.ignored && part.text.includes(AUTO_WORKTREE_NOTICE_MARKER),
  )
}

export function buildAutoWorktreeNotice(mainWorktreePath: string): string {
  return [
    "<system-reminder>",
    AUTO_WORKTREE_NOTICE_MARKER,
    "",
    `This session is mutating the git main worktree at \`${mainWorktreePath}\`. Concurrent write/edit or git operations there can interfere with other agents or local changes.`,
    "",
    "Do NOT create a worktree on your own. Before any further write or edit, ask the user whether they want an isolated worktree.",
    "",
    "If the user agrees, create one with `git worktree add <path> -b <branch>` using a path outside the project directory, then switch into it before continuing. If the user declines, proceed only on the paths they authorized.",
    "</system-reminder>",
  ].join("\n")
}
