/**
 * Classifies the last message in a tail segment for checkpoint rebuild context.
 * Used by renderRebuildContext to decide which system reminder addendum to emit.
 */

export type LastMessageInfo =
  | { role: "assistant"; finish: "tool-calls" }
  | { role: "assistant"; finish: "stop" }
  | { role: "tool" }
  | { role: "user" }

/**
 * Inspects the last element of a message array and returns a classification.
 * Accepts any array of objects with at minimum `{ role: string; finish?: string }`.
 *
 * - assistant with finish="tool-calls" → mid-loop autonomous
 * - assistant with any other finish     → completed naturally
 * - tool                                → tool result pending
 * - user                                → awaiting assistant response
 *
 * Returns undefined for an empty array.
 */
export function computeLastMessageInfo(
  msgs: ReadonlyArray<{ role: string; finish?: string }>,
): LastMessageInfo | undefined {
  if (msgs.length === 0) return undefined
  const last = msgs[msgs.length - 1]
  if (last.role === "assistant")
    return { role: "assistant", finish: last.finish === "tool-calls" ? "tool-calls" : "stop" }
  if (last.role === "tool") return { role: "tool" }
  return { role: "user" }
}
