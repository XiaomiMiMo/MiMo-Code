import { Instance } from "@/project/instance"
import { Config } from "@/config"
import { Database, eq } from "@/storage"
import { SessionTable } from "@/session/session.sql"
import type { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { Effect, Option } from "effect"
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
 * habit gate so both keep one notion of git layout.
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
        `STOP. This session is mutating the git MAIN worktree at \`${mainWorktreePath}\`. Concurrent write/edit or git operations there can interfere with other agents or local changes.`,
        "",
        "This repo already uses worktrees — that is the repo habit, not an optional suggestion.",
        "",
        "You MUST create an isolated worktree for this task and switch into it before ANY further write, edit, apply_patch, or git mutation under the main worktree (or any other repo main worktree later). You do not need to ask the user first.",
        "",
        "Do NOT write/edit/apply_patch under the main worktree path again after this notice. Do NOT continue the current change in place. Pause the implementation, isolate first, then resume only in the new worktree.",
        "",
        "After isolating, briefly confirm the worktree path (and branch if you created one) in your next reply. Isolation failure must be stated explicitly — do not silently fall back to writing main.",
        "",
        "This rule is not limited to the path above. If you later start writing to another git repository that already uses worktrees, or run git mutations against its main worktree, isolate there the same way without asking.",
      ]
    : [
        `This session is mutating the git main worktree at \`${mainWorktreePath}\`. Concurrent write/edit or git operations there can interfere with other agents or local changes.`,
        "",
        "No linked worktrees exist in this repo yet, so habit is unknown. Choose intentionally:",
        "- Prefer an isolated worktree for multi-file or risky changes.",
        "- You MAY create one without asking if the task clearly benefits from isolation.",
        "- Otherwise ask the user before further main-worktree writes, or continue only if they already accepted main as the working area.",
        "",
        "Do NOT ignore this trade-off and keep editing main as if nothing was flagged. If you stay on main, say so in your reply.",
        "",
        "This rule is not limited to the path above. Apply the same check when you later write or run git mutations against another repository's main worktree.",
      ]
  return ["<system-reminder>", AUTO_WORKTREE_NOTICE_MARKER, "", ...body, "</system-reminder>"].join("\n")
}

/**
 * Tool-level gate: reject write/edit into a git MAIN worktree when this is a
 * habit repo (already has linked worktrees) and `auto_worktree` is on.
 *
 * Soft notice alone is not enough — models finish single-shot tasks without
 * isolating, and multi-file turns keep writing main. A failed tool call is the
 * only consequence with a forced recovery path (create worktree, then retry).
 *
 * Non-habit repos and linked worktrees pass. Does not auto-create a worktree.
 */
/**
 * Who may recover by creating a worktree:
 * - `parent` (primary / root agent): isolate yourself, then retry.
 * - `child` (subagent): NEVER self-isolate — report the block; the parent
 *   decides isolation. Concurrent subagents each running `git worktree add`
 *   race on `.git/worktrees` and leave orphan trees the parent never chose.
 */
export type IsolationRole = "parent" | "child"

export function isolationRoleFromContext(ctx?: { agentMode?: string; actorID?: string }): IsolationRole {
  // Prefer actorID: custom agents default to mode "all" but still run as a
  // spawned child. Aligns with task.ts (`actorID !== undefined && !== "main"`).
  if (ctx?.actorID !== undefined && ctx.actorID !== "main") return "child"
  return ctx?.agentMode === "subagent" ? "child" : "parent"
}

export function buildMainWorktreeWriteRejection(mainRoot: string, role: IsolationRole = "parent"): Error {
  // Policy + outcome only — do not prescribe `git worktree add` recipes.
  // The model already knows isolation; micromanaging the command caused
  // sibling-path / external_directory friction and hid real product issues.
  const shared = [
    `Blocked: this path is inside the git MAIN worktree \`${mainRoot}\`.`,
    "",
    "This repo already uses worktrees. Writes to the main worktree are not allowed for this session.",
    "",
  ]
  const body =
    role === "child"
      ? [
          "You are a subagent. Do NOT create a worktree yourself and do NOT retry this write on main.",
          "",
          "Escalate to the parent agent: report this block, wait for a worktree path the parent chose, then retry only under that path.",
          "",
          "Do NOT retry against the main worktree path.",
        ]
      : [
          "Isolate this change into a worktree under this repo, then retry with a path under that worktree.",
          "",
          "Do NOT retry against the main worktree path. Do not ask the user to lift this block.",
        ]
  const err = new Error([...shared, ...body].join("\n"))
  err.name = "AutoWorktreeBlockedError"
  return err
}

/**
 * Shared habit-repo gate. `mainRoot` must already be a git MAIN worktree root.
 * Throws when the repo already uses worktrees and `config.auto_worktree` is true.
 * Missing Config fails OPEN — default product is off, unreadable config must not block writes.
 *
 * Child (spawned actor / agentMode=subagent) gets the escalate-to-parent rejection,
 * never the self-isolate recovery path (see IsolationRole).
 */
export const assertHabitRepoMainWriteBlocked = Effect.fn("Tool.assertHabitRepoMainWriteBlocked")(function* (
  mainRoot: string,
  ctx?: { agentMode?: string; actorID?: string },
) {
  if (!repoHasLinkedWorktrees(mainRoot)) return
  const svc = yield* Effect.serviceOption(Config.Service)
  if (Option.isNone(svc)) return
  const cfg = yield* svc.value.get()
  if (cfg.auto_worktree !== true) return
  throw buildMainWorktreeWriteRejection(mainRoot, isolationRoleFromContext(ctx))
})

/**
 * Assert that `filepath` may be written under the current auto-worktree policy.
 * Throws `AutoWorktreeBlockedError` when the target is a habit-repo main worktree
 * and config.auto_worktree is true. Linked worktrees and non-git paths pass.
 *
 * Config is resolved with `Effect.serviceOption` so Tool.Def.execute stays
 * R = never (same pattern as external-directory memory gate).
 */
export const assertMainWorktreeWriteAllowed = Effect.fn("Tool.assertMainWorktreeWriteAllowed")(function* (
  filepath: string,
  ctx?: { agentMode?: string; actorID?: string },
) {
  const mainRoot = findGitMainWorktree(filepath)
  if (!mainRoot) return
  yield* assertHabitRepoMainWriteBlocked(mainRoot, ctx)
})
