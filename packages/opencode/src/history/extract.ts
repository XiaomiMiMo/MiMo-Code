import { cleanDataUrls } from "./media"
import type { MessageV2 } from "../session/message-v2"

export type Kind = "user_text" | "assistant_text" | "tool_input" | "tool_error" | "reasoning" | "tool_output" | "file"

export type Extracted = { kind: Kind; body: string; tool_name: string | null }

export function extract(...args: Parameters<typeof extractRaw>): Extracted | null {
  const result = extractRaw(...args)
  return result ? { ...result, body: cleanDataUrls(result.body, undefined, "index") } : null
}

function extractRaw(part: MessageV2.Part, messageRole: "user" | "assistant"): Extracted | null {
  switch (part.type) {
    case "text": {
      const kind: Kind = messageRole === "user" ? "user_text" : "assistant_text"
      if (!part.text) return null
      return { kind, body: part.text, tool_name: null }
    }
    case "reasoning": {
      if (!part.text) return null
      return { kind: "reasoning", body: part.text, tool_name: null }
    }
    case "file": {
      return { kind: "file", body: `${part.filename ?? ""} ${part.mime}`, tool_name: null }
    }
    case "tool": {
      const state = part.state
      if (state.status === "pending" || state.status === "running") return null

      if (state.status === "error") {
        return {
          kind: "tool_error",
          body: `${part.tool} ${JSON.stringify(state.input ?? {})} ${state.error ?? ""}`,
          tool_name: part.tool,
        }
      }
      if (state.status === "completed") {
        return {
          kind: "tool_output",
          body: `${part.tool} ${JSON.stringify(state.input ?? {})} ${JSON.stringify(state.output ?? "")} ${(state.attachments ?? []).map((file) => `${file.filename ?? ""} ${file.mime}`).join(" ")}`.trim(),
          tool_name: part.tool,
        }
      }
      return null
    }
    default:
      return null
  }
}
