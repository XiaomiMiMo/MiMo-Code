import * as path from "path"
import type { ProjectID } from "../project/schema"
import type { SessionID } from "../session/schema"

const VALID_SCOPES = ["global", "projects", "sessions"] as const

const TASK_ID_RE = /^T\d+(\.\d+)*$/

/**
 * Returns true when the relative path under <root>/memory/ is one of the
 * precise paths the checkpoint-writer subagent is permitted to write:
 *   projects/<pid>/memory.md          (or memory-<topic>.md spillover)
 *   sessions/<sid>/checkpoint.md      (or checkpoint-<topic>.md spillover)
 *   sessions/<sid>/notes.md
 *   sessions/<sid>/tasks/<task_id>/*.md
 *
 * Rejects anything else. Catches writer drift like
 * `<pid>/pinned.md` (v4 name) at write time.
 */
function isCheckpointWriterAllowed(parts: string[]): boolean {
  if (parts.length < 3) return false

  if (parts[0] === "projects") {
    if (parts.length !== 3) return false
    const file = parts[2]
    if (!file.endsWith(".md")) return false
    const lower = file.toLowerCase()
    return lower === "memory.md" || lower.startsWith("memory-")
  }

  if (parts[0] === "sessions") {
    const rest = parts.slice(2)
    if (rest.length === 1) {
      const file = rest[0]
      if (!file.endsWith(".md")) return false
      return file === "checkpoint.md" || file === "notes.md" || file.startsWith("checkpoint-")
    }
    if (rest.length === 3 && rest[0] === "tasks") {
      return TASK_ID_RE.test(rest[1]) && rest[2].endsWith(".md")
    }
    return false
  }

  return false
}

/**
 * Format the multi-line "where to write memory" hint shown to main agent
 * when it attempts a path with no scope dir or an invalid scope. Both throws
 * use byte-identical bodies — the corrective action is the same.
 */
function formatMainAgentHelp(memoryFile: string, checkpointFile: string, notesFile: string, target: string): string {
  return (
    `Memory writes go under <memoryRoot>/<scope>/<scope_id>/<key>.md (scope: global | projects | sessions). You attempted: ${target}.\n` +
    `\n` +
    `The main agent can only write notes.md directly:\n` +
    `  ${notesFile}\n` +
    `    Append \`## [turn N · ISO-Z]\` entries for free-form scratch.\n` +
    `\n` +
    `Structured memory files are checkpoint-writer-only:\n` +
    `  ${memoryFile}\n` +
    `  ${checkpointFile}\n` +
    `checkpoint.md, MEMORY.md, task progress, and memory-/checkpoint-<topic>.md spillovers are checkpoint-writer's domain.`
  )
}

/**
 * Returns true when a non-writer agent is using its only direct memory write
 * channel: the current session's notes.md scratchpad.
 */
function isCurrentSessionNotes(parts: string[], sessionID: SessionID): boolean {
  return parts[0] === "sessions" && parts[1] === sessionID && parts.length === 3 && parts[2] === "notes.md"
}

function isOwnTaskMemory(parts: string[], sessionID: SessionID, taskId?: string): boolean {
  return (
    !!taskId &&
    parts[0] === "sessions" &&
    parts[1] === sessionID &&
    parts[2] === "tasks" &&
    parts[3] === taskId &&
    parts.length >= 5 &&
    parts[parts.length - 1].endsWith(".md")
  )
}

function formatMainAgentDenied(
  memoryFile: string,
  checkpointFile: string,
  notesFile: string,
  rel: string,
  target: string,
): string {
  return (
    `Path '${rel}' is reserved for the checkpoint-writer subagent or is not a legal main-agent memory write.\n` +
    `The main agent can only write notes.md directly:\n` +
    `  ${notesFile}\n` +
    `Structured memory files are checkpoint-writer-only:\n` +
    `  ${memoryFile}\n` +
    `  ${checkpointFile}\n` +
    `Subagent bound to task <TID> may write to tasks/<TID>/*.md (pass task_id when spawning).\n` +
    `You attempted: ${target}.`
  )
}

/**
 * Throws if the target write would violate memory-scope or reserved-path
 * rules. Pure function — does not touch the filesystem.
 *
 * Two policies:
 *   - For checkpoint-writer subagent: must be in the precise allowlist above
 *     (<pid>/MEMORY.md, <sid>/checkpoint.md, <sid>/tasks/<id>/*.md, plus
 *     memory-/checkpoint- spillover variants).
 *   - For all other agents: can only write the current session's notes.md,
 *     except a task-bound subagent may write its own tasks/<TID>/*.md subtree.
 *
 * Non-memory paths pass through unmodified.
 */
export function assertMemoryWriteAllowed(input: {
  target: string
  agentName: string
  memoryRoot: string
  projectID: ProjectID
  sessionID: SessionID
  taskId?: string
}): void {
  const { target, agentName, memoryRoot, projectID, sessionID } = input
  const memoryFile = path.join(memoryRoot, "projects", projectID, "MEMORY.md")
  const notesFile = path.join(memoryRoot, "sessions", sessionID, "notes.md")
  const checkpointFile = path.join(memoryRoot, "sessions", sessionID, "checkpoint.md")
  const taskMemDir = path.join(memoryRoot, "sessions", sessionID, "tasks")
  const normalizedRoot = memoryRoot.endsWith(path.sep) ? memoryRoot : memoryRoot + path.sep
  if (!target.startsWith(normalizedRoot)) return

  const rel = path.relative(memoryRoot, target)
  const parts = rel.split(path.sep)

  if (parts.length < 2) {
    throw new Error(formatMainAgentHelp(memoryFile, checkpointFile, notesFile, target))
  }
  const scope = parts[0]
  if (!VALID_SCOPES.includes(scope as (typeof VALID_SCOPES)[number])) {
    throw new Error(formatMainAgentHelp(memoryFile, checkpointFile, notesFile, target))
  }

  if (agentName === "checkpoint-writer") {
    if (!isCheckpointWriterAllowed(parts)) {
      throw new Error(
        `Path '${rel}' is not in the checkpoint-writer allowlist.\n` +
          `Writer may only write to:\n` +
          `  ${memoryFile}                           — project memory (or memory-<topic>.md spillover)\n` +
          `  ${checkpointFile}                       — session checkpoint (or checkpoint-<topic>.md spillover)\n` +
          `  ${taskMemDir}/<task_id>/*.md            — per-task narratives (any .md filename)\n` +
          `You attempted: ${target}.`,
      )
    }
    return
  }

  if (isCurrentSessionNotes(parts, sessionID)) return
  if (isOwnTaskMemory(parts, sessionID, input.taskId)) return

  throw new Error(formatMainAgentDenied(memoryFile, checkpointFile, notesFile, rel, target))
}
