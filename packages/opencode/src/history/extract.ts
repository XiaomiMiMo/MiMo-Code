import { cleanDataUrls } from "./media"
import { boundedJson, previewForIndex } from "./index-preview"
import type { MessageV2 } from "../session/message-v2"

export type Extracted = { body: string; tool_name: string | null }

/**
 * Compose FTS body for a part. Length policy is the tool-call-result path:
 * `previewToolOutput` / `Truncate.output` (`tool/truncate.ts`). Full text stays
 * in PartTable (and tool-output files) for history get.
 */
export function extract(part: MessageV2.Part): Extracted | null {
  switch (part.type) {
    case "text": {
      if (!part.text) return null
      return { body: previewForIndex(part.text), tool_name: null }
    }
    case "reasoning": {
      if (!part.text) return null
      return { body: previewForIndex(part.text), tool_name: null }
    }
    case "file": {
      return { body: previewForIndex(fileText(part)), tool_name: null }
    }
    case "tool": {
      const state = part.state
      if (state.status === "pending" || state.status === "running") return null

      // Prefer the stored tool result string when present (already went through
      // Truncate.output on the tool path); still bound it for legacy full payloads.
      const attachments = previewForIndex((state.attachments ?? []).map(fileText).join(" "))
      if (state.status === "error") {
        const errorText = typeof state.error === "string" ? state.error : boundedJson(state.error)
        return {
          body: previewForIndex(
            `${part.tool} ${boundedJson(state.input ?? {})} ${previewForIndex(errorText)} ${attachments}`.trim(),
          ),
          tool_name: part.tool,
        }
      }
      if (state.status === "completed") {
        const outputText =
          typeof state.output === "string" ? state.output : boundedJson(state.output ?? "")
        return {
          body: previewForIndex(
            `${part.tool} ${boundedJson(state.input ?? {})} ${previewForIndex(outputText)} ${attachments}`.trim(),
          ),
          tool_name: part.tool,
        }
      }
      return null
    }
    case "subtask":
      return {
        body: previewForIndex([part.prompt, part.description, part.agent, part.command].filter(Boolean).join(" ")),
        tool_name: null,
      }
    case "compaction": {
      const body = [part.projection?.summary, part.projection?.manifest].filter(Boolean).join(" ")
      return body ? { body: previewForIndex(body), tool_name: null } : null
    }
    case "patch":
      return part.files.length ? { body: previewForIndex(part.files.join(" ")), tool_name: null } : null
    case "agent":
      return {
        body: previewForIndex([part.name, part.source?.value].filter(Boolean).join(" ")),
        tool_name: null,
      }
    case "retry":
      return {
        body: previewForIndex(
          [part.error.data.message, part.error.data.responseBody].filter(Boolean).join(" "),
        ),
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
    file.source ? boundedJson(file.source) : undefined,
    file.url && !/^data:/i.test(file.url) ? file.url : undefined,
  ]
    .filter(Boolean)
    .join(" ")
}

export function extractCleaned(part: MessageV2.Part): Extracted | null {
  const result = extract(part)
  return result ? { ...result, body: cleanDataUrls(result.body, undefined, "index") } : null
}
