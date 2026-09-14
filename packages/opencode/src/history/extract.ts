import { cleanDataUrls } from "./media"
import type { MessageV2 } from "../session/message-v2"

export type Extracted = { body: string; tool_name: string | null }

export function extract(...args: Parameters<typeof extractRaw>): Extracted | null {
  const result = extractRaw(...args)
  return result ? { ...result, body: cleanDataUrls(result.body, undefined, "index") } : null
}

function extractRaw(part: MessageV2.Part): Extracted | null {
  switch (part.type) {
    case "text": {
      if (!part.text) return null
      return { body: part.text, tool_name: null }
    }
    case "reasoning": {
      if (!part.text) return null
      return { body: part.text, tool_name: null }
    }
    case "file": {
      return { body: `${part.filename ?? ""} ${part.mime}`, tool_name: null }
    }
    case "tool": {
      const state = part.state
      if (state.status === "pending" || state.status === "running") return null

      const attachments = (state.attachments ?? []).map((file) => `${file.filename ?? ""} ${file.mime}`).join(" ")
      if (state.status === "error") {
        return {
          body: `${part.tool} ${JSON.stringify(state.input ?? {})} ${state.error ?? ""} ${attachments}`.trim(),
          tool_name: part.tool,
        }
      }
      if (state.status === "completed") {
        return {
          body: `${part.tool} ${JSON.stringify(state.input ?? {})} ${JSON.stringify(state.output ?? "")} ${attachments}`.trim(),
          tool_name: part.tool,
        }
      }
      return null
    }
    default:
      return null
  }
}
