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
const MAX_LINES = 50

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

function toolLine(part: ToolPart, unseen: boolean): string {
  const args = formatToolArgs(part.state.input)
  const call = args ? `${part.tool}(${args})` : `${part.tool}()`
  if (part.state.status === "error") return `- ${call} → error: ${truncate(part.state.error, MAX_ARG_CHARS)}`
  if (part.state.status === "pending" || part.state.status === "running") return `- ${call} → interrupted`
  if (unseen && !part.metadata?.providerExecuted) return `- ${call} ${UNSEEN_MARK}`
  return `- ${call}`
}

/**
 * Marks a completed call that ran but whose result no model request carried:
 * the calls of the last assistant message, which the rebuild came right after.
 */
export const UNSEEN_MARK = "→ ran, result not seen"

export function isBoundaryUser(msg: WithParts): boolean {
  return msg.info.role === "user" && msg.parts.some((p) => p.type === "checkpoint" || p.type === "compaction")
}

export function isRebuildBoundary(msg: WithParts): boolean {
  return msg.info.role === "user" && msg.parts.some((p) => p.type === "checkpoint")
}

/**
 * The tail's last step that reached the model: its newest assistant message
 * with content. A request the provider rejected (for example for context
 * overflow) leaves an assistant message without content after it.
 */
export function lastStep(tail: readonly WithParts[]): WithParts | undefined {
  return tail.findLast(
    (msg) =>
      msg.info.role === "assistant" &&
      msg.parts.some(
        (p) => p.type === "tool" || ((p.type === "text" || p.type === "reasoning") && p.text.trim().length > 0),
      ),
  )
}

function digestLines(tail: readonly WithParts[]): { lines: string[]; omitted: number; marked: boolean } {
  const lines: string[] = []
  const last = lastStep(tail)
  for (const msg of tail) {
    // Never re-digest a prior rebuild/compaction boundary — that folds the
    // previous dump into itself on a second rebuild.
    if (isBoundaryUser(msg)) continue
    // Tail user messages are quoted in the boundary's Recent user input
    // section (and stay live after a legacy boundary); do not also log them.
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
        lines.push(toolLine(part, msg === last))
      }
    }
  }
  // Keep the newest lines: the marked calls of the last step come last. The
  // omitted ones stay readable through the history tool.
  const kept = lines.slice(-MAX_LINES)
  // Only open with the note for lines that actually appear.
  return {
    lines: kept,
    omitted: lines.length - kept.length,
    marked: kept.some((line) => line.includes("→ interrupted") || line.includes(UNSEEN_MARK)),
  }
}

/** Section body only (header + lines). Empty string when there is nothing to list. */
export function renderTailDigest(tail: readonly WithParts[]): string {
  const { lines, omitted, marked } = digestLines(tail)
  if (lines.length === 0) return ""
  return [
    "# Recent activity",
    "",
    ...(marked
      ? [
          "(calls marked below ran or were interrupted before their results reached you — re-run a read-only call whose result you need; check the current state before repeating a call that changes files or runs commands)",
          "",
        ]
      : []),
    ...(omitted > 0 ? [`(${omitted} earlier activity lines omitted — use the history tool to read them)`] : []),
    ...lines,
  ].join("\n")
}

function checkpointPart(msg: WithParts): CheckpointPart | undefined {
  if (msg.info.role !== "user") return undefined
  return msg.parts.find((p): p is CheckpointPart => p.type === "checkpoint")
}

/**
 * Legacy rebuild boundaries were stamped at watermark + 1 ms, so they sort
 * before the tail they digest. A boundary appended after its tail is created
 * no earlier than the newest tail message.
 */
function isLegacyBoundary(boundary: WithParts, newest: WithParts): boolean {
  return boundary.info.time.created < newest.info.time.created
}

/**
 * Drop assistant messages in (coveredUpTo, digestUpTo] after a legacy
 * rebuild boundary. A boundary appended after the newest message leaves its
 * tail outside the window, so there is nothing to drop. Older boundaries were
 * stamped at watermark + 1 ms and sort before the tail they digest; such a
 * boundary is recognised from stored data alone: its `time.created` is
 * earlier than that of the `digestUpTo` message. For those, the activity list
 * already sits in the boundary's rebuild context, so this removes the
 * now-redundant verbatim tool/assistant tail while post-insert messages stay
 * live.
 *
 * Filtering by message-id range — not by the boundary's position in the
 * array — so a same-millisecond tail message cannot escape collapse by
 * sorting before the boundary's synthetic time.
 *
 * User-role messages are never dropped: the last user is where insertReminders
 * persists skill-catalog gates, and a file-only or
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
  const newest = msgs.find((m) => m.info.id === digestUpTo)
  if (!newest || !isLegacyBoundary(boundary, newest)) return msgs as WithParts[]

  const coveredUpTo = part.coveredUpTo
  const live = msgs.filter(
    (m) => m.info.id <= coveredUpTo || m.info.id > digestUpTo || m.info.role === "user",
  )
  if (live.length === msgs.length) return msgs as WithParts[]
  return live as WithParts[]
}
