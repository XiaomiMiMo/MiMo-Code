import { Instance } from "@/project/instance"
import { Database, eq } from "@/storage"
import { SessionTable } from "@/session/session.sql"
import { checkConflict, type ConflictResult } from "./conflict-detection"

const HINT_TEMPLATE = (conflict: ConflictResult) => `

⚠️ Auto-Worktree Notice

You are writing to the main worktree. Consider creating an isolated worktree for this task:

- Create a worktree: use the \`worktree\` tool or run \`git worktree add <path> -b <branch>\`
- Base branch: consider fetching latest origin/main first, then branch from main
- Worktree path convention: <data>/worktree/<project-id>/<name> (managed by MiMo)

Conflict detected: ${conflict.reason}${conflict.activeSessionId ? ` (session: ${conflict.activeSessionId})` : ""}

If this task is a simple fix or Q&A, you can skip this notice and continue.`

export async function shouldInjectHint(sessionID: string): Promise<boolean> {
  const sent = Database.use((db) =>
    db.select({ val: SessionTable.auto_worktree_hint_sent })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID as any))
      .get(),
  )
  if (sent?.val) return false
  if (Instance.project.vcs !== "git") return false
  if (Instance.directory !== Instance.project.worktree) return false
  const conflict = await checkConflict(Instance.directory)
  return conflict.hasConflict
}

export async function injectHint(sessionID: string): Promise<string> {
  if (!(await shouldInjectHint(sessionID))) return ""
  Database.use((db) =>
    db.update(SessionTable)
      .set({ auto_worktree_hint_sent: 1 })
      .where(eq(SessionTable.id, sessionID as any))
      .run(),
  )
  const conflict = await checkConflict(Instance.directory)
  return HINT_TEMPLATE(conflict)
}
