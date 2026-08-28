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

// Process-lifetime cache: the same file/dir is re-resolved on every insertReminders
// step until the notice fires.
const mainWorktreeCache = new Map<string, string | null>()

/**
 * Walk up from `startDir` and return the git MAIN worktree root, or null.
 * `.git` as a directory means a main worktree; `.git` as a `gitdir:` file means
 * a linked worktree (already isolated — not a hint target).
 */
export function findGitMainWorktree(startDir: string): string | null {
  const key = path.resolve(startDir)
  const cached = mainWorktreeCache.get(key)
  if (cached !== undefined) return cached
  let result: string | null = null
  try {
    let dir = key
    for (;;) {
      const dotGit = path.join(dir, ".git")
      if (fs.existsSync(dotGit)) {
        const stat = fs.statSync(dotGit)
        result = stat.isDirectory() ? dir : null
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    result = null
  }
  mainWorktreeCache.set(key, result)
  return result
}

export function isGitMainWorktree(startDir: string): boolean {
  return findGitMainWorktree(startDir) !== null
}

/**
 * True when this main checkout already has at least one linked worktree.
 * `.git/worktrees/` is where git records them; its presence (with entries)
 * is the cheap "this project actually uses worktrees" signal. Repos that
 * never create worktrees stay silent so the notice does not nag them.
 */
export function repoHasLinkedWorktrees(mainWorktreeRoot: string): boolean {
  const dir = path.join(mainWorktreeRoot, ".git", "worktrees")
  try {
    if (!fs.existsSync(dir)) return false
    return fs.readdirSync(dir).some((name) => name.length > 0 && !name.startsWith("."))
  } catch {
    return false
  }
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
 * All git MAIN worktrees this transcript has mutated so far, limited to
 * repos that already have linked worktrees (the "this project uses
 * worktrees" habit signal).
 *
 * Path-based, not session-directory-based: a session bound to a non-git
 * scratch dir that `cd`s into another project's main checkout still hits.
 * Isolated worktrees, non-git paths, and main checkouts with no linked
 * worktrees do not.
 */
export function sessionMutatedMainWorktrees(messages: MessageV2.WithParts[]): string[] {
  const hits = new Set<string>()
  const consider = (mainRoot: string | null | undefined) => {
    if (mainRoot && repoHasLinkedWorktrees(mainRoot)) hits.add(mainRoot)
  }
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
        consider(findGitMainWorktree(resolveCandidate(raw)))
        continue
      }

      if (part.tool === "bash") {
        const list = part.state.metadata?.mainWorktreeHits
        if (!Array.isArray(list)) continue
        for (const item of list) {
          if (typeof item === "string" && item.length > 0) consider(item)
        }
      }
    }
  }
  return [...hits]
}

/** First git main worktree this transcript mutated, or undefined. */
export function firstMutatedMainWorktree(messages: MessageV2.WithParts[]): string | undefined {
  return sessionMutatedMainWorktrees(messages)[0]
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
    "",
    "This rule is not limited to the path above. If you later start writing to another git repository, or run git mutations against another repo's main worktree, apply the same check there: ask the user before continuing in that main worktree.",
    "</system-reminder>",
  ].join("\n")
}
