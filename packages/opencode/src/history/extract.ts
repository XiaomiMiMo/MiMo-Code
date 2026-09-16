import { boundedJson, INDEX_MAX_BYTES, INDEX_MAX_LINES, previewForIndex, previewToolOutput } from "./index-preview"
import type { MessageV2 } from "../session/message-v2"

export type Extracted = { body: string; tool_name: string | null }

/** Cap tool `input` so a huge argv/json cannot evict output / outputPath from the index body. */
const INPUT_INDEX_BUDGET = {
  maxBytes: Math.floor(INDEX_MAX_BYTES / 4),
  maxLines: Math.floor(INDEX_MAX_LINES / 4),
} as const

/** Same phrasing as `formatToolTruncationHint` in `tool/truncate.ts`. */
const OUTPUT_PATH_HINT = /Full output saved to:\s*\S+/

/**
 * Preview tool output for FTS. When a stored result still carries the
 * `Full output saved to:` path (tool-result path), keep that hint inside the
 * budget even if a huge legacy payload would otherwise head-truncate it away.
 */
function previewOutputForIndex(outputText: string): string {
  return keepPathHint(outputText, previewForIndex(outputText))
}

/** Re-attach tool name and `Full output saved to:` if a preview would drop them; stay within budget. */
function keepPathHint(source: string, previewed: string): string {
  const hint = OUTPUT_PATH_HINT.exec(source)?.[0]
  if (!hint || previewed.includes(hint)) return previewed
  const room = Math.max(0, INDEX_MAX_BYTES - Buffer.byteLength(hint, "utf-8") - 2)
  const head = previewToolOutput(source, { maxBytes: room, direction: "head" }).content
  return `${head}\n${hint}`
}

/** Finalize tool FTS body so tool name + path hint survive large payloads. */
function finalizeToolBody(tool: string, outputText: string, composed: string): string {
  const hint = OUTPUT_PATH_HINT.exec(outputText)?.[0]
  const previewed = previewForIndex(composed)
  const missing: string[] = []
  if (tool && !previewed.includes(tool)) missing.push(tool)
  if (hint && !previewed.includes(hint)) missing.push(hint)
  if (missing.length === 0) return previewed
  const extra = missing.join("\n")
  const room = Math.max(0, INDEX_MAX_BYTES - Buffer.byteLength(extra, "utf-8") - 2)
  let body = previewToolOutput(composed, { maxBytes: room, direction: "head" }).content
  if (tool && !body.includes(tool)) body = `${tool}\n${body}`
  if (hint && !body.includes(hint)) body = `${body}\n${hint}`
  return body
}

/**
 * Compose FTS body for a part. Length policy is the tool-call-result path:
 * `previewToolOutput` / `Truncate.output` (`tool/truncate.ts`) via `previewForIndex`.
 * Full text stays in PartTable (and tool-output files) for history get.
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

      const attachments = previewForIndex((state.attachments ?? []).map(fileText).join(" "))
      // Prefer stored tool-result string; bound input separately so output keeps budget share.
      const inputPart = boundedJson(state.input ?? {}, INPUT_INDEX_BUDGET)
      if (state.status === "error") {
        const errorText = typeof state.error === "string" ? state.error : boundedJson(state.error)
        const composed = `${part.tool} ${inputPart} ${previewOutputForIndex(errorText)} ${attachments}`.trim()
        return { body: finalizeToolBody(part.tool, errorText, composed), tool_name: part.tool }
      }
      if (state.status === "completed") {
        const outputText =
          typeof state.output === "string" ? state.output : boundedJson(state.output ?? "")
        const composed = `${part.tool} ${inputPart} ${previewOutputForIndex(outputText)} ${attachments}`.trim()
        return { body: finalizeToolBody(part.tool, outputText, composed), tool_name: part.tool }
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
