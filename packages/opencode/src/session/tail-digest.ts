import type { CheckpointPart, ToolPart, WithParts } from "./message-v2"

/**
 * Post-rebuild tail → compact activity list.
 *
 * The log is rendered as a "# Recent activity" section inside the rebuild
 * context (same user message as the checkpoint body), not as a trailing
 * block. Tool results are dropped by construction — only tool name + args
 * are listed. Synthetic text parts are skipped so harness reminders never
 * look like real user/assistant turns.
 */

const MAX_LINE_CHARS = 240
const MAX_ARG_CHARS = 80
const MAX_LINES = 200

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (cleaned.length <= max) return cleaned
  return cleaned.slice(0, Math.max(0, max - 1)) + "…"
}

function formatToolArgs(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  return Object.entries(input)
    .map(([key, value]) => {
      if (typeof value === "string") return `${key}=${JSON.stringify(truncate(value, MAX_ARG_CHARS))}`
      let raw: string | undefined
      try {
        raw = JSON.stringify(value)
      } catch {
        raw = undefined
      }
      return `${key}=${truncate(raw ?? "[unserializable]", MAX_ARG_CHARS)}`
    })
    .join(", ")
}

function toolLine(part: ToolPart): string {
  const args = formatToolArgs(part.state.input)
  const call = args ? `${part.tool}(${args})` : `${part.tool}()`
  if (part.state.status === "error") return `- ${call} → error: ${truncate(part.state.error, MAX_ARG_CHARS)}`
  if (part.state.status === "pending" || part.state.status === "running") return `- ${call} → interrupted`
  return `- ${call}`
}

function isBoundaryUser(msg: WithParts): boolean {
  return msg.info.role === "user" && msg.parts.some((p) => p.type === "checkpoint" || p.type === "compaction")
}

function digestLines(tail: readonly WithParts[]): { lines: string[]; interrupted: boolean } {
  const lines: string[] = []
  for (const msg of tail) {
    // Never re-digest a prior rebuild/compaction boundary — that folds the
    // previous dump into itself on a second rebuild.
    if (isBoundaryUser(msg)) continue
    // User-role messages always stay live after collapse (see
    // collapseCheckpointTail); do not also log them.
    if (msg.info.role === "user") continue
    for (const part of msg.parts) {
      if (part.type === "text" && !part.ignored && !part.synthetic) {
        const text = part.text.trim()
        if (!text) continue
        lines.push(`- ${msg.info.role}: ${truncate(text, MAX_LINE_CHARS)}`)
        continue
      }
      if (part.type === "subtask") {
        lines.push(`- subtask: ${truncate(part.command ?? part.agent, MAX_LINE_CHARS)}`)
        continue
      }
      if (part.type === "tool") {
        lines.push(toolLine(part))
      }
    }
  }
  const kept = lines.slice(0, MAX_LINES)
  // Only flag interruption for lines that actually appear — otherwise the
  // banner can fire for a tool that was dropped by the MAX_LINES cap.
  return { lines: kept, interrupted: kept.some((line) => line.includes("→ interrupted")) }
}

/** Section body only (header + lines). Empty string when there is nothing to list. */
export function renderTailDigest(tail: readonly WithParts[]): string {
  const { lines, interrupted } = digestLines(tail)
  if (lines.length === 0) return ""
  return [
    "# Recent activity",
    "",
    ...(interrupted ? ["(tool loop interrupted by rebuild — re-run any tools you still need)", ""] : []),
    ...lines,
  ].join("\n")
}

function checkpointPart(msg: WithParts): CheckpointPart | undefined {
  if (msg.info.role !== "user") return undefined
  return msg.parts.find((p): p is CheckpointPart => p.type === "checkpoint")
}

/**
 * Drop assistant messages in (coveredUpTo, digestUpTo] after the latest
 * rebuild boundary. The activity list itself is already in the boundary's
 * rebuild context (written at insert time), so this only removes the
 * now-redundant verbatim tool/assistant tail. Post-insert messages stay live.
 *
 * Filtering by message-id range — not by the boundary's position in the
 * array — so a same-millisecond tail message cannot escape collapse by
 * sorting before the boundary's synthetic time (watermark+1).
 *
 * User-role messages are never dropped: the last user is where insertReminders
 * persists skill-catalog / auto-worktree gates, and a file-only or
 * synthetic-only user turn is still an instruction the provider must see.
 * Collapsing it would mark the reminder "already sent" while the provider
 * never receives it.
 */
export function collapseCheckpointTail(msgs: readonly WithParts[]): WithParts[] {
  const boundary = msgs.findLast((m) => m.info.role === "user" && m.parts.some((p) => p.type === "checkpoint"))
  if (!boundary) return msgs as WithParts[]

  const part = checkpointPart(boundary)
  if (!part?.digestUpTo) return msgs as WithParts[]

  const digestUpTo = part.digestUpTo
  const coveredUpTo = part.coveredUpTo
  const live = msgs.filter(
    (m) => m.info.id <= coveredUpTo || m.info.id > digestUpTo || m.info.role === "user",
  )
  if (live.length === msgs.length) return msgs as WithParts[]
  return live as WithParts[]
}
