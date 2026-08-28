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
// step until the notice fires, and again after that for newly-mutated paths.
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

function resolveCandidate(target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(Instance.directory, target)
}

function toolInputString(part: MessageV2.Part, key: string): string | undefined {
  if (part.type !== "tool") return undefined
  const value = (part.state.input as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * All git MAIN worktrees this transcript has mutated so far.
 *
 * Path-based, not session-directory-based: a session bound to a non-git
 * scratch dir that `cd`s into another project's main checkout still hits.
 * Isolated worktrees and non-git paths do not. Multiple repos are returned
 * together — first write usually names one; later writes add more.
 */
export function sessionMutatedMainWorktrees(messages: MessageV2.WithParts[]): string[] {
  const hits = new Set<string>()
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
        if (hit) hits.add(hit)
        continue
      }

      if (part.tool === "bash") {
        const list = part.state.metadata?.mainWorktreeHits
        if (!Array.isArray(list)) continue
        for (const item of list) {
          if (typeof item === "string" && item.length > 0) hits.add(item)
        }
      }
    }
  }
  return [...hits]
}

/** Main worktree paths already named in a previous Auto-Worktree notice. */
export function noticedMainWorktrees(messages: MessageV2.WithParts[]): Set<string> {
  const seen = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "text" || !part.synthetic || part.ignored) continue
      if (!part.text.includes(AUTO_WORKTREE_NOTICE_MARKER)) continue
      const paths = part.metadata?.mainWorktreePaths
      if (Array.isArray(paths)) {
        for (const p of paths) {
          if (typeof p === "string" && p.length > 0) seen.add(p)
        }
      }
    }
  }
  return seen
}

/** Hits that have not yet been named in any notice. Empty ⇒ nothing to inject. */
export function pendingMainWorktreeNotices(messages: MessageV2.WithParts[]): string[] {
  const noticed = noticedMainWorktrees(messages)
  return sessionMutatedMainWorktrees(messages).filter((hit) => !noticed.has(hit))
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

export function buildAutoWorktreeNotice(mainWorktreePaths: string[]): string {
  const listed = mainWorktreePaths.map((p) => `- \`${p}\``).join("\n")
  const noun = mainWorktreePaths.length === 1 ? "main worktree" : "main worktrees"
  return [
    "<system-reminder>",
    AUTO_WORKTREE_NOTICE_MARKER,
    "",
    `This session is mutating git ${noun} that other agents or local changes may also touch:`,
    listed,
    "",
    "Do NOT create a worktree on your own. Before any further write or edit, ask the user whether they want an isolated worktree.",
    "",
    "If the user agrees, create one with `git worktree add <path> -b <branch>` using a path outside the project directory, then switch into it before continuing. If the user declines, proceed only on the paths they authorized.",
    "</system-reminder>",
  ].join("\n")
}
