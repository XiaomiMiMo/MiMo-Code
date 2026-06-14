import type { MessageV2 } from "../session/message-v2"

export type Kind =
  | "user_text"
  | "assistant_text"
  | "tool_input"
  | "tool_error"
  | "reasoning"
  | "tool_output"

export const DEFAULT_KINDS: ReadonlyArray<Kind> = [
  "user_text",
  "assistant_text",
  "tool_input",
  "tool_error",
]

export type Extracted = { kind: Kind; body: string; tool_name: string | null }

export function extract(
  part: MessageV2.Part,
  messageRole: "user" | "assistant",
  enabledKinds: ReadonlySet<Kind>,
): Extracted | null {
  switch (part.type) {
    case "text": {
      const kind: Kind = messageRole === "user" ? "user_text" : "assistant_text"
      if (!enabledKinds.has(kind)) return null
      if (!part.text) return null
      return { kind, body: part.text, tool_name: null }
    }
    case "reasoning": {
      if (!enabledKinds.has("reasoning")) return null
      if (!part.text) return null
      return { kind: "reasoning", body: part.text, tool_name: null }
    }
    case "tool": {
      const state = part.state
      if (state.status === "pending" || state.status === "running") return null

      if (state.status === "error" && enabledKinds.has("tool_error")) {
        return {
          kind: "tool_error",
          body: `${part.tool} ${JSON.stringify(state.input ?? {})} ${state.error ?? ""}`,
          tool_name: part.tool,
        }
      }
      if (state.status === "completed" && enabledKinds.has("tool_output")) {
        return {
          kind: "tool_output",
          body: `${part.tool} ${JSON.stringify(state.input ?? {})} ${JSON.stringify(state.output ?? "")}`,
          tool_name: part.tool,
        }
      }
      if (enabledKinds.has("tool_input")) {
        return {
          kind: "tool_input",
          body: `${part.tool} ${JSON.stringify(state.input ?? {})}`,
          tool_name: part.tool,
        }
      }
      return null
    }
    default:
      return null
  }
}
