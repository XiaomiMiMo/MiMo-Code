import type { LanguageModelV3FinishReason } from "@ai-sdk/provider"

export function mapOpenAICompatibleFinishReason(
  finishReason: string | null | undefined,
): LanguageModelV3FinishReason["unified"] {
  // Some gateways (e.g. opencode.ai/zen/go/v1 serving muse-spark) never send a
  // finish_reason: absent in streaming chunks, null in non-streaming. That is a
  // normal completion, not an anomaly — treating it as "other" flags every
  // response from such models as degraded (#2173). Only an unrecognized
  // non-empty value falls through to "other".
  if (finishReason == null) {
    return "stop"
  }
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
