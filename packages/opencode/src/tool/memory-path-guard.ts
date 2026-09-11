import * as path from "path"
import type { ProjectID } from "../project/schema"
import type { SessionID } from "../session/schema"

const VALID_SCOPES = ["global", "projects", "sessions"] as const

/** Agents that may write memory or the project's `.mimocode/` directory. The
 *  checkpoint writer has a stricter memory-only policy below. */
const WRITE_SANDBOXED_AGENTS: ReadonlySet<string> = new Set(["dream", "distill"])

/**
 * Hard write-boundary for sandboxed system agents. checkpoint-writer is
 * memory-only; dream/distill may also write under `<worktree>/.mimocode/`.
 * Pure — does not touch the filesystem.
 *
 * This is enforced in the single write gate (assertWriteAllowed), so it cannot
 * be bypassed by a widened `write`/`edit` permission or a new write tool: those
 * tools all funnel through the gate. `bash` is NOT covered here (a separate,
 * prompt-level discipline), matching the "trust the model, permission layer is
 * a backstop" stance — this closes the biggest tool-mediated gap: arbitrary
 * source-file writes via write/edit/apply_patch/notebook_edit.
 */
export function assertAgentWriteSandbox(input: {
  target: string
  agentName: string
  memoryRoot: string
  worktree: string
}): void {
  // Resolve here rather than trusting the caller: write.ts/edit.ts pass an
  // absolute file_path THROUGH unnormalized, so a target like
  // `<worktree>/.mimocode/../src/x.ts` would string-prefix-match `.mimocode`
  // yet land in src/. path.resolve folds `..` before comparison, closing that
  // escape. (apply_patch already resolves; this makes the guard robust for all
  // callers.) The roots are resolved too so the comparison is apples-to-apples.
  const target = path.resolve(input.target)
  const memoryRoot = path.resolve(input.memoryRoot)
  if (input.agentName === "checkpoint-writer") {
    if (pathContains(memoryRoot, target)) return
    throw new Error(
      `Agent '${input.agentName}' may only write under the memory tree.\n` +
        `  memory: ${memoryRoot}\n` +
        `You attempted: ${input.target}.`,
    )
  }

  if (!WRITE_SANDBOXED_AGENTS.has(input.agentName)) return

  const dotDir = path.resolve(input.worktree, ".mimocode")
  if (pathContains(memoryRoot, target) || pathContains(dotDir, target)) return

  throw new Error(
    `Agent '${input.agentName}' may only write under the memory tree or ${dotDir}.\n` +
      `  memory: ${memoryRoot}\n` +
      `  config: ${dotDir}\n` +
      `You attempted: ${input.target}.`,
  )
}

/** True when `child` is `root` itself or nested under it. Normalizes a trailing
 *  separator so `/a/memory` does not match `/a/memory-other`. */
function pathContains(root: string, child: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root.slice(0, -1) : root
  return child === normalizedRoot || child.startsWith(normalizedRoot + path.sep)
}

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
function formatMainAgentHelp(memoryFile: string, notesFile: string, target: string): string {
  return (
    `Memory writes go under <memoryRoot>/<scope>/<scope_id>/<key>.md (scope: global | projects | sessions). You attempted: ${target}.\n` +
    `\n` +
    `Canonical main-agent paths (copy verbatim):\n` +
    `  ${memoryFile}\n` +
    `    Edit ## Rules / ## Architecture decisions / ## Discovered durable knowledge.\n` +
    `  ${notesFile}\n` +
    `    Append \`## [turn N · ISO-Z]\` entries for free-form scratch.\n` +
    `\n` +
    `Other free-form <key>.md under a valid scope dir are also allowed.\n` +
    `checkpoint.md, task progress, and memory-/checkpoint-<topic>.md spillovers are checkpoint-writer's domain.`
  )
}

/**
 * Returns true when the path is reserved-by-pattern for the checkpoint-writer
 * subagent — main agent must not write it directly.
 *
 * In v5 only the writer-managed task directory remains reserved-by-pattern.
 * Main agent CAN write <pid>/MEMORY.md and <sid>/checkpoint.md (system prompt
 * teaches it the rules).
 */
function isReservedForCheckpointWriter(parts: string[]): boolean {
  if (parts[0] !== "sessions" || parts.length < 4) return false
  // Anything under <sid>/tasks/ is writer-managed (use task tool revise action).
  if (parts[2] === "tasks") return true
  return false
}

/**
 * Throws if the target write would violate memory-scope or reserved-path
 * rules. Pure function — does not touch the filesystem.
 *
 * Two policies:
 *   - For checkpoint-writer subagent: must be in the precise allowlist above
 *     (<pid>/MEMORY.md, <sid>/checkpoint.md, <sid>/tasks/<id>/*.md, plus
 *     memory-/checkpoint- spillover variants).
 *   - For all other agents: cannot write <sid>/tasks/* — that's
 *     checkpoint-writer-only.
 *
 * Both policies sit behind the memory write switch: when the caller passes
 * `writeEnabled: false`, every write inside the memory tree is refused
 * regardless of agent or path. Purity is preserved by taking the flag as a
 * parameter — this module never reads config itself.
 *
 * Non-memory paths and free keys under valid scopes pass through unmodified.
 */
export function assertMemoryWriteAllowed(input: {
  target: string
  agentName: string
  memoryRoot: string
  projectID: ProjectID
  sessionID: SessionID
  taskId?: string
  /** Whether memory writing is enabled. Omitted → enabled (the default). */
  writeEnabled?: boolean
}): void {
  const { target, agentName, memoryRoot, projectID, sessionID } = input
  const memoryFile = path.join(memoryRoot, "projects", projectID, "MEMORY.md")
  const notesFile = path.join(memoryRoot, "sessions", sessionID, "notes.md")
  const checkpointFile = path.join(memoryRoot, "sessions", sessionID, "checkpoint.md")
  const taskMemDir = path.join(memoryRoot, "sessions", sessionID, "tasks")
  const normalizedRoot = memoryRoot.endsWith(path.sep) ? memoryRoot : memoryRoot + path.sep
  if (!target.startsWith(normalizedRoot)) return

  // Memory write switch. Deliberately worded so the refusal cannot be mistaken
  // for a path/permission problem — a model that reads "not allowed here" tends to
  // retry a different memory path, which would just loop. Says WRITING is off, not
  // that memory is off: existing memory is still readable. But it must not promise
  // AUTOMATIC availability — while writing is off, checkpoint rebuild short-circuits
  // to compaction, and the memory dumps only a rebuild produces never appear. So the
  // reader is told to go get it, not that it will arrive. English only, like every
  // other message this module throws: it has no locale to consult, and the consuming
  // client that surfaces it carries its own translations.
  if (input.writeEnabled === false) {
    throw new Error(
      `Memory WRITING is disabled: config \`memory.disable_write\` is true, so no new memory may be written.\n` +
        `Refused: ${target}.\n` +
        `Do NOT retry with another memory path — every path under ${memoryRoot} is refused while writing is off.\n` +
        `Existing memory is still READABLE: the \`memory\` search tool works and you can read files under ${memoryRoot} directly.\n` +
        `It is NOT loaded for you automatically while writing is off — checkpoint rebuild falls back to compaction, so search or read it explicitly when you need it.\n` +
        `To re-enable, set \`memory.disable_write: false\` in config.`,
    )
  }

  const rel = path.relative(memoryRoot, target)
  const parts = rel.split(path.sep)

  if (parts.length < 2) {
    throw new Error(formatMainAgentHelp(memoryFile, notesFile, target))
  }
  const scope = parts[0]
  if (!VALID_SCOPES.includes(scope as (typeof VALID_SCOPES)[number])) {
    throw new Error(formatMainAgentHelp(memoryFile, notesFile, target))
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

  if (isReservedForCheckpointWriter(parts)) {
    // Spec ② follow-up: subagent bound to a specific TID may write anywhere
    // under ITS OWN tasks/<TID>/ subtree. Cross-task writes still rejected.
    // parts shape under tasks: ["sessions", sid, "tasks", "<TID>", "<file>.md", ...]
    // NOTE: `parts.length >= 5` is deliberately looser than the checkpoint-writer
    // path (which requires exactly tasks/<TID>/<file>.md). A subagent may nest
    // its own workspace (tasks/<TID>/sub/foo.md); the `parts[3] === input.taskId`
    // guard still confines it to its own task, so the extra depth is safe.
    if (
      input.taskId &&
      parts[2] === "tasks" &&
      parts[3] === input.taskId &&
      parts.length >= 5 &&
      parts[parts.length - 1].endsWith(".md")
    ) {
      return
    }
    throw new Error(
      `Path '${rel}' is reserved for the checkpoint-writer subagent.\n` +
        `Main agent writes to:\n` +
        `  ${memoryFile}\n` +
        `  ${notesFile}\n` +
        `Subagent bound to task <TID> may write to tasks/<TID>/*.md (pass task_id when spawning).\n` +
        `You attempted: ${target}.`,
    )
  }
}
