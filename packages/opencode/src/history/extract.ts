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
      return { body: fileText(part), tool_name: null }
    }
    case "tool": {
      const state = part.state
      if (state.status === "pending" || state.status === "running") return null

      const attachments = (state.attachments ?? []).map(fileText).join(" ")
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
    case "subtask":
      return {
        body: [part.prompt, part.description, part.agent, part.command].filter(Boolean).join(" "),
        tool_name: null,
      }
    case "compaction": {
      const body = [part.projection?.summary, part.projection?.manifest].filter(Boolean).join(" ")
      return body ? { body, tool_name: null } : null
    }
    case "patch":
      return part.files.length ? { body: part.files.join(" "), tool_name: null } : null
    case "agent":
      return { body: [part.name, part.source?.value].filter(Boolean).join(" "), tool_name: null }
    case "retry":
      return {
        body: [part.error.data.message, part.error.data.responseBody].filter(Boolean).join(" "),
        tool_name: null,
      }
    case "snapshot":
    case "checkpoint":
    case "step-start":
    case "step-finish":
      return null
    default:
      part satisfies never
      return null
  }
}

function fileText(file: Pick<MessageV2.FilePart, "filename" | "mime" | "source" | "url">) {
  return [
    file.filename,
    file.mime,
    file.source ? JSON.stringify(file.source) : undefined,
    file.url && !/^data:/i.test(file.url) ? file.url : undefined,
  ]
    .filter(Boolean)
    .join(" ")
}
