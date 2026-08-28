import type { CheckpointPart, ToolPart, WithParts } from "./message-v2"

/**
 * Post-rebuild tail → compact activity list.
 *
 * The log is rendered as a "## Recent activity" section inside the rebuild
 * context (same user message as the checkpoint body), not as a trailing
 * block. Tool results are dropped by construction — only tool name + args
 * are listed.
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
      const raw = JSON.stringify(value)
      return `${key}=${truncate(raw ?? "undefined", MAX_ARG_CHARS)}`
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

function digestLines(tail: readonly WithParts[]): { lines: string[]; interrupted: boolean } {
  const lines: string[] = []
  let interrupted = false
  for (const msg of tail) {
    for (const part of msg.parts) {
      if (part.type === "text" && !part.ignored) {
        const text = part.text.trim()
        if (!text) continue
        lines.push(`- ${msg.info.role}: ${truncate(text, MAX_LINE_CHARS)}`)
        continue
      }
      if (part.type === "file" && msg.info.role === "user") {
        lines.push(`- user: [file ${part.filename ?? part.mime}]`)
        continue
      }
      if (part.type === "subtask") {
        lines.push(`- subtask: ${truncate(part.command ?? part.agent, MAX_LINE_CHARS)}`)
        continue
      }
      if (part.type === "tool") {
        lines.push(toolLine(part))
        if (part.state.status === "pending" || part.state.status === "running") interrupted = true
      }
    }
  }
  return { lines: lines.slice(0, MAX_LINES), interrupted }
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

function checkpointDigestUpTo(msg: WithParts): string | undefined {
  if (msg.info.role !== "user") return undefined
  const part = msg.parts.find((p): p is CheckpointPart => p.type === "checkpoint")
  return part?.digestUpTo
}

/**
 * Drop messages in [checkpoint+1, digestUpTo] after the latest rebuild
 * boundary. The activity list itself is already in the boundary's rebuild
 * context (written at insert time), so this only removes the now-redundant
 * verbatim tail. Post-insert messages stay live.
 */
export function collapseCheckpointTail(msgs: readonly WithParts[]): WithParts[] {
  const boundaryIdx = msgs.findLastIndex((m) => m.info.role === "user" && m.parts.some((p) => p.type === "checkpoint"))
  if (boundaryIdx < 0) return msgs as WithParts[]

  const digestUpTo = checkpointDigestUpTo(msgs[boundaryIdx]!)
  if (!digestUpTo) return msgs as WithParts[]

  const head = msgs.slice(0, boundaryIdx + 1)
  const live = msgs.slice(boundaryIdx + 1).filter((m) => m.info.id > digestUpTo)
  if (live.length === msgs.length - boundaryIdx - 1) return msgs as WithParts[]
  return [...head, ...live]
}
