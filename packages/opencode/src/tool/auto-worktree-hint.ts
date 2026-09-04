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
// step until the notice fires. Bounded so a long-lived daemon cannot accumulate
// unbounded path keys across sessions.
const MAIN_WORKTREE_CACHE_MAX = 512
const mainWorktreeCache = new Map<string, string | null>()

export type GitLayout = {
  /** Directory that contains `.git` (main worktree root, or linked worktree root). */
  worktreeRoot: string
  /** Resolved git dir: `.git` itself for main, `gitdir:` target for linked. */
  gitDir: string
  isMain: boolean
}

/**
 * Walk up from `startDir` to the nearest `.git`. Shared by the main-worktree
 * habit gate and conflict-detection so both keep one notion of git layout.
 */
export function walkGitLayout(startDir: string): GitLayout | null {
  try {
    let dir = path.resolve(startDir)
    for (;;) {
      const dotGit = path.join(dir, ".git")
      if (fs.existsSync(dotGit)) {
        const stat = fs.statSync(dotGit)
        if (stat.isDirectory()) {
          return { worktreeRoot: dir, gitDir: dotGit, isMain: true }
        }
        const content = fs.readFileSync(dotGit, "utf-8").trim()
        const match = content.match(/^gitdir:\s*(.+)$/)
        if (!match) return null
        const gitDir = path.resolve(path.dirname(dotGit), match[1].trim())
        if (!fs.existsSync(gitDir)) return null
        return { worktreeRoot: dir, gitDir, isMain: false }
      }
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  } catch {
    return null
  }
}

/**
 * Walk up from `startDir` and return the git MAIN worktree root, or null.
 * `.git` as a directory means a main worktree; `.git` as a `gitdir:` file means
 * a linked worktree (already isolated — not a hint target).
 */
export function findGitMainWorktree(startDir: string): string | null {
  const key = path.resolve(startDir)
  const cached = mainWorktreeCache.get(key)
  if (cached !== undefined) return cached
  const layout = walkGitLayout(key)
  const result = layout?.isMain ? layout.worktreeRoot : null
  if (mainWorktreeCache.size >= MAIN_WORKTREE_CACHE_MAX) mainWorktreeCache.clear()
  mainWorktreeCache.set(key, result)
  return result
}

export function isGitMainWorktree(startDir: string): boolean {
  return findGitMainWorktree(startDir) !== null
}

/**
 * True when this main checkout already has at least one linked worktree.
 * Positive signal only: "this repo already uses worktrees". Absence means
 * unknown, not "this repo never will" — unknown still gets a notice, with
 * the ask-first copy.
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

function bashSucceeded(part: MessageV2.Part): boolean {
  if (part.type !== "tool" || part.state.status !== "completed") return false
  return part.state.metadata?.exit === 0
}

/**
 * All git MAIN worktrees this transcript has mutated so far.
 *
 * Path-based, not session-directory-based: a session bound to a non-git
 * scratch dir that `cd`s into another project's main checkout still hits.
 * Isolated worktrees and non-git paths do not. Failed bash commands
 * (non-zero exit) are ignored. Habit (linked worktrees present) is not a
 * gate here — it only changes the notice copy.
 */
export function sessionMutatedMainWorktrees(messages: MessageV2.WithParts[]): string[] {
  const hits = new Set<string>()
  const consider = (mainRoot: string | null | undefined) => {
    if (mainRoot) hits.add(mainRoot)
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
        if (!bashSucceeded(part)) continue
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

export function isAutoWorktreeHintSent(sessionID: SessionID): boolean {
  return Boolean(
    Database.use((db) =>
      db
        .select({ sent: SessionTable.auto_worktree_hint_sent })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()?.sent,
    ),
  )
}

export function markAutoWorktreeHintSent(sessionID: SessionID): void {
  Database.use((db) =>
    db
      .update(SessionTable)
      .set({ auto_worktree_hint_sent: true })
      .where(eq(SessionTable.id, sessionID))
      .run(),
  )
}

export function hasAutoWorktreeNotice(message: MessageV2.WithParts): boolean {
  return message.parts.some(
    (part) =>
      part.type === "text" && part.synthetic && !part.ignored && part.text.includes(AUTO_WORKTREE_NOTICE_MARKER),
  )
}

/** True if any user message in the session still carries the notice. */
export function sessionHasAutoWorktreeNotice(messages: MessageV2.WithParts[]): boolean {
  return messages.some((m) => m.info.role === "user" && hasAutoWorktreeNotice(m))
}

export function buildAutoWorktreeNotice(mainWorktreePath: string): string {
  const hasHabit = repoHasLinkedWorktrees(mainWorktreePath)
  const body = hasHabit
    ? [
        `This session is mutating the git main worktree at \`${mainWorktreePath}\`. Concurrent write/edit or git operations there can interfere with other agents or local changes.`,
        "",
        "This repo already uses worktrees. Isolate this task in a new worktree and switch into it before any further write or edit. You do not need to ask the user first.",
        "",
        "This rule is not limited to the path above. If you later start writing to another git repository that already uses worktrees, or run git mutations against its main worktree, isolate there the same way without asking.",
      ]
    : [
        `This session is mutating the git main worktree at \`${mainWorktreePath}\`. Concurrent write/edit or git operations there can interfere with other agents or local changes.`,
        "",
        "Do NOT create a worktree on your own. Before any further write or edit, ask the user whether they want an isolated worktree.",
        "",
        "If the user agrees, isolate this task in a new worktree and switch into it before continuing. If the user declines, continue with the original plan without creating a worktree.",
        "",
        "This rule is not limited to the path above. If you later start writing to another git repository, or run git mutations against another repo's main worktree, apply the same check there: ask the user before continuing in that main worktree.",
      ]
  return ["<system-reminder>", AUTO_WORKTREE_NOTICE_MARKER, "", ...body, "</system-reminder>"].join("\n")
}
