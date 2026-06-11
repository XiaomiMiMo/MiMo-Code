type AlignMsg = {
  readonly info: { readonly role: "user" | "assistant" }
  readonly parts: ReadonlyArray<{ readonly type: string }>
}

/**
 * Walk backwards from `idx` to find the nearest message satisfying:
 *   - role === "user", AND
 *   - parts is not entirely tool_result parts.
 *
 * Used to align a delta slice's start so the LLM does not see an orphan
 * tool_result. If no qualifying message exists in `[0, idx]`, returns 0
 * (caller may still receive an LLM rejection, in which case writerFailures
 * increments via the existing path — degenerate sessions only).
 *
 * If `idx` is past the end of `msgs`, returns `idx` unchanged: the empty
 * delta is a legitimate (post-watermark) state.
 */
export function alignToNonToolResultUser(msgs: ReadonlyArray<AlignMsg>, idx: number): number {
  if (idx >= msgs.length) return idx
  for (let i = idx; i >= 0; i--) {
    const m = msgs[i]
    if (m.info.role !== "user") continue
    // empty-parts message treated as valid: cannot be an orphan tool_result
    const allToolResult = m.parts.length > 0 && m.parts.every((p) => p.type === "tool_result")
    if (!allToolResult) return i
  }
  return 0
}
