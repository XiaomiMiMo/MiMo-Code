import type { MetadataExtractor } from "@ai-sdk/openai-compatible"
import { isRecord } from "@/util/record"

function opaque(body: unknown, field: "message" | "delta") {
  if (!isRecord(body) || !Array.isArray(body.choices)) return undefined
  const choice: unknown = body.choices[0]
  const message = isRecord(choice) ? choice[field] : undefined
  const value = isRecord(message) ? message.reasoning_opaque : undefined
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function metadata(value: string | undefined) {
  return value ? { openaiCompatible: { reasoning_opaque: value } } : undefined
}

export const openAICompatibleMetadataExtractor: MetadataExtractor = {
  async extractMetadata({ parsedBody }) {
    return metadata(opaque(parsedBody, "message"))
  },
  createStreamExtractor() {
    let last: string | undefined
    return {
      processChunk(chunk) {
        last = opaque(chunk, "delta") ?? last
      },
      buildMetadata: () => metadata(last),
    }
  },
}
