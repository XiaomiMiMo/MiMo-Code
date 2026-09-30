import type { TrajectoryMessage, TrajectoryPart } from "@mimo-ai/plugin"
import { MessageV2 } from "./message-v2"

/**
 * Replace `data:` URLs in file parts with a compact summary tag, leaving
 * non-data URLs (file paths, http(s) attachments) untouched. Keeps the
 * trajectory JSON-safe without exploding payload size on inline images.
 */
function fileUrlSummary(url: string, mime: string, filename?: string) {
  if (!url.startsWith("data:")) return url
  return `[data-url:${mime}${filename ? `:${filename}` : ""}]`
}

function serializeFilePart(part: MessageV2.FilePart): MessageV2.FilePart {
  return { ...part, url: fileUrlSummary(part.url, part.mime, part.filename) }
}

/**
 * Strip `data:` URLs from any FilePart attachments inside a tool result.
 * Mutation is shallow — original part is not modified.
 */
function sanitizeToolState(state: MessageV2.ToolPart["state"]): MessageV2.ToolPart["state"] {
  if ("attachments" in state && state.attachments && state.attachments.length > 0) {
    return { ...state, attachments: state.attachments.map(serializeFilePart) }
  }
  return state
}

/**
 * Serialize a MessageV2.Part for the trajectory wire format. Preserves every
 * field the runtime stores (ID, time, metadata, source, raw, attachments,
 * tokens, etc.) — only `data:` URLs are summarized to keep payloads tractable.
 * The result is a structural superset of MessageV2.Part and is safe to
 * round-trip through JSON.
 */
export function serializePart(part: MessageV2.Part): TrajectoryPart {
  if (part.type === "file") return serializeFilePart(part) as unknown as TrajectoryPart
  if (part.type === "tool") return { ...part, state: sanitizeToolState(part.state) } as unknown as TrajectoryPart
  return part as unknown as TrajectoryPart
}

/** Stringify an assistant error blob (NamedError, AbortedError, etc.) for plugin payloads. */
export function sessionErrorText(error: MessageV2.Assistant["error"]): string | undefined {
  if (!error) return undefined
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return JSON.stringify(error)
}

/** Concatenate non-synthetic, non-ignored user text parts (the visible user query). */
export function userQueryText(parts: MessageV2.Part[]): string {
  return parts
    .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => p.text)
    .join("\n")
}

/** Last non-synthetic assistant text, or stringified structured output if present. */
export function assistantFinalText(message: MessageV2.Assistant, parts: MessageV2.Part[]): string | undefined {
  if (message.structured !== undefined) return JSON.stringify(message.structured)
  return parts.findLast((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)?.text
}

/**
 * Serialize a slice of session messages into the wire trajectory format.
 *
 * Field-level fidelity:
 * - Spreads the full MessageV2 info (model, tools, format, tokens, cost,
 *   modelID, providerID, agent, agentID, error, finish, structured, summary,
 *   provenance, path, parentID, mode, variant, …) so a consumer can replay
 *   the conversation exactly as the runtime saw it.
 * - Spreads the full MessageV2.Part (PartID, time, metadata, source, raw,
 *   attachments, tokens, snapshot, …) for every part type — including unknown
 *   future types — without dropping fields.
 *
 * Slice-level fidelity is the caller's responsibility: pass the same slice the
 * agent actually saw (e.g. via MessageV2.filterCompactedEffect with the
 * session's contextFrom/contextWatermark) for replay parity.
 */
export function serializeTrajectoryMessages(msgs: MessageV2.WithParts[]): TrajectoryMessage[] {
  return msgs.map((msg) => ({
    ...msg.info,
    created: msg.info.time.created,
    parts: msg.parts.map(serializePart),
  })) as unknown as TrajectoryMessage[]
}

/** Replace the assistant entry in a message slice with freshly loaded parts. */
export function withAssistantParts(
  msgs: MessageV2.WithParts[],
  assistant: MessageV2.Assistant,
  parts: MessageV2.Part[],
): MessageV2.WithParts[] {
  const idx = msgs.findIndex((m) => m.info.id === assistant.id)
  if (idx === -1) return [...msgs, { info: assistant, parts }]
  return msgs.map((m, i) => (i === idx ? { info: assistant, parts } : m))
}
