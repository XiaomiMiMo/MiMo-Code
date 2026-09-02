import type { LanguageModelV3FinishReason } from "@ai-sdk/provider"

export function mapOpenAICompatibleFinishReason(
  finishReason: string | null | undefined,
): LanguageModelV3FinishReason["unified"] {
  // Null/undefined finish_reason indicates the gateway completed without an
  // explicit signal (e.g. muse-spark via zen/go). Treat as "stop" since the
  // response was delivered normally — defaulting to "other" would cause
  // classify.ts to flag every such response as degraded.
  if (finishReason == null) return "stop"

  switch (finishReason) {
    case "stop":
      return "stop"
    case "length":
      return "length"
    case "content_filter":
      return "content-filter"
    case "function_call":
    case "tool_calls":
      return "tool-calls"
    default:
      return "other"
  }
}
