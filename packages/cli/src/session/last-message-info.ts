/**
 * Classifies the last message in a tail segment for checkpoint rebuild context.
 * Used by renderRebuildContext to decide which system reminder addendum to emit.
 * Session messages are only user or assistant.
 */

export type LastMessageInfo =
  | { role: "assistant"; finish: "tool-calls" }
  | { role: "assistant"; finish: "stop" }
  | { role: "user" }

/**
 * Inspects the last element of a message array and returns a classification.
 *
 * - assistant with finish="tool-calls" → mid-loop autonomous
 * - assistant with any other finish     → completed naturally
 * - user                                → awaiting assistant response
 *
 * Returns undefined for an empty array.
 */
export function computeLastMessageInfo(
  msgs: ReadonlyArray<{ role: "user" | "assistant"; finish?: string }>,
): LastMessageInfo | undefined {
  if (msgs.length === 0) return undefined
  const last = msgs[msgs.length - 1]
  if (last.role === "assistant")
    return { role: "assistant", finish: last.finish === "tool-calls" ? "tool-calls" : "stop" }
  return { role: "user" }
}
