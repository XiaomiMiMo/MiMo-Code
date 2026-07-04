import type { AssistantMessage } from "@mimo-ai/sdk/v2"

// Context occupancy represented by the latest assistant message. A compaction
// summary's input/cache tokens describe the discarded pre-compact history it
// was asked to summarize, so only its output — the summary text that seeds the
// new context window — counts toward occupancy.
export function contextTokens(message: AssistantMessage): number {
  if (message.summary) return message.tokens.output
  return (
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    message.tokens.cache.read +
    message.tokens.cache.write
  )
}
