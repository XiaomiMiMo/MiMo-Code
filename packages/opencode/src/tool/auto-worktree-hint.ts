import { Instance } from "@/project/instance"
import { checkConflict, type ConflictResult } from "./conflict-detection"

const hinted = new Set<string>()

const HINT_TEMPLATE = (conflict: ConflictResult) => `

⚠️ Auto-Worktree Notice

You are writing to the main worktree. Consider creating an isolated worktree for this task:

- Create a worktree: use the \`worktree\` tool or run \`git worktree add <path> -b <branch>\`
- Base branch: consider fetching latest origin/main first, then branch from main
- Worktree path convention: <data>/worktree/<project-id>/<name> (managed by MiMo)

Conflict detected: ${conflict.reason}${conflict.activeSessionId ? ` (session: ${conflict.activeSessionId})` : ""}

If this task is a simple fix or Q&A, you can skip this notice and continue.`

export async function shouldInjectHint(sessionID: string): Promise<boolean> {
  if (hinted.has(sessionID)) return false
  if (Instance.project.vcs !== "git") return false
  if (Instance.directory !== Instance.project.worktree) return false
  const conflict = await checkConflict(Instance.directory)
  return conflict.hasConflict
}

export async function injectHint(sessionID: string): Promise<string> {
  if (!(await shouldInjectHint(sessionID))) return ""
  hinted.add(sessionID)
  const conflict = await checkConflict(Instance.directory)
  return HINT_TEMPLATE(conflict)
}
