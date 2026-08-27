import { Instance } from "@/project/instance"
import { Database, eq } from "@/storage"
import { SessionTable } from "@/session/session.sql"
import type { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"

export const AUTO_WORKTREE_NOTICE_MARKER = "Auto-Worktree Notice"

/** Tools whose successful completion means the session mutated project files. */
const FILE_WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "multiedit", "notebook_edit"])

export function isMainWorktree(): boolean {
  return Instance.project.vcs === "git" && Instance.worktree === Instance.project.worktree
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

/** True when the transcript already shows a completed file-mutating tool call. */
export function sessionWroteFiles(messages: MessageV2.WithParts[]): boolean {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      if (FILE_WRITE_TOOLS.has(part.tool)) return true
      if (part.tool === "bash" && part.state.metadata?.fileWrite === true) return true
    }
  }
  return false
}

export function hasAutoWorktreeNotice(message: MessageV2.WithParts): boolean {
  return message.parts.some(
    (part) =>
      part.type === "text" && part.synthetic && !part.ignored && part.text.includes(AUTO_WORKTREE_NOTICE_MARKER),
  )
}

export function buildAutoWorktreeNotice(): string {
  return [
    "<system-reminder>",
    AUTO_WORKTREE_NOTICE_MARKER,
    "",
    "This session is running in the main worktree and has started writing files there. Concurrent write/edit work in the main worktree can interfere with other agents or local changes.",
    "",
    "Do NOT create a worktree on your own. Before any further write or edit, ask the user whether they want an isolated worktree.",
    "",
    "If the user agrees, create one with `git worktree add <path> -b <branch>` using a path outside the project directory, then switch into it before continuing. If the user declines, proceed only on the paths they authorized.",
    "</system-reminder>",
  ].join("\n")
}
