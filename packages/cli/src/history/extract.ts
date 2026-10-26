import { boundedJson, INDEX_MAX_BYTES, INDEX_MAX_LINES, previewForIndex, previewToolOutput } from "./index-preview"
import type { MessageV2 } from "../session/message-v2"

/**
 * Content classification for `history_fts.kind`.
 * Consumers may filter on this column; History.search does not accept kind.
 */
export type Kind =
  | "user_text"
  | "assistant_text"
  | "synthetic_text"
  | "summary_text"
  | "reasoning"
  | "file"
  | "tool_output"
  | "tool_error"
  | "subtask"
  | "compaction"
  | "patch"
  | "agent"
  | "retry"

export type Extracted = { kind: Kind; body: string; body_idx: string; tool_name: string | null }

/**
 * Search representation (body_idx): isolate every Han char from Han/Latin/digit
 * neighbors so unicode61 phrases match CJK in mixed text (npm打包脚本2).
 * Only this column is rewritten — original `body` stays lossless (D5/D7).
 */
export function buildSearchIndexText(text: string): string {
  return text
    .replace(/([\p{Script=Han}])(?=\p{Script=Han})/gu, "$1 ")
    .replace(/([\p{Script=Han}])(?=[\p{L}\p{N}])/gu, "$1 ")
    .replace(/([\p{L}\p{N}])(?=\p{Script=Han})/gu, "$1 ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Cap tool `input` so a huge argv/json cannot evict output / outputPath from the index body. */
const INPUT_INDEX_BUDGET = {
  maxBytes: Math.floor(INDEX_MAX_BYTES / 4),
  maxLines: Math.floor(INDEX_MAX_LINES / 4),
} as const

/** Same phrasing as `formatToolTruncationHint` in `tool/truncate.ts`. */
const OUTPUT_PATH_HINT = /Full output saved to:\s*\S+/

function previewOutputForIndex(outputText: string): string {
  return clampIndexBody(keepPathHint(outputText, previewForIndex(outputText)))
}

function clampIndexBody(body: string): string {
  if (Buffer.byteLength(body, "utf-8") <= INDEX_MAX_BYTES) return body
  return previewForIndex(body)
}

function keepPathHint(source: string, previewed: string): string {
  const hint = OUTPUT_PATH_HINT.exec(source)?.[0]
  if (!hint || previewed.includes(hint)) return previewed
  const room = Math.max(0, INDEX_MAX_BYTES - Buffer.byteLength(hint, "utf-8") - 2)
  const head = previewToolOutput(source, { maxBytes: room, direction: "head" }).content
  return `${head}\n${hint}`
}

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
  return clampIndexBody(body)
}

/**
 * Compose FTS body for a part. Preview budget applies to the **original** text;
 */
export function extract(
  part: MessageV2.Part,
  messageRole: "user" | "assistant",
  opts?: { summary?: boolean },
): Extracted | null {
  // Index ALL content for History.search (shared tool contract). Visibility
  // for other consumers is enforced at query time via kind + projection semantics.
  void opts
  const raw = extractRaw(part, messageRole, opts)
  if (!raw) return null
  // body = original preview (display); body_idx = search form (D5/D7).
  return { ...raw, body_idx: buildSearchIndexText(raw.body) }
}

function extractRaw(part: MessageV2.Part, messageRole: "user" | "assistant", opts?: { summary?: boolean }): Omit<Extracted, "body_idx"> | null {
  switch (part.type) {
    case "text": {
      if (!part.text) return null
      const anyPart = part as { synthetic?: boolean; metadata?: { mimo?: { kind?: string } } }
      const hiddenMeta = anyPart.metadata?.mimo?.kind === "compose-next-slash"
      const kind = anyPart.synthetic || hiddenMeta
        ? "synthetic_text"
        : opts?.summary && messageRole === "assistant"
          ? "summary_text"
          : messageRole === "user"
            ? "user_text"
            : "assistant_text"
      return { kind, body: previewForIndex(part.text), tool_name: null }
    }
    case "reasoning": {
      if (!part.text) return null
      return { kind: "reasoning", body: previewForIndex(part.text), tool_name: null }
    }
    case "file": {
      return { kind: "file", body: previewForIndex(fileText(part)), tool_name: null }
    }
    case "tool": {
      const state = part.state
      if (state.status === "pending" || state.status === "running") return null

      const attachments = previewForIndex((state.attachments ?? []).map(fileText).join(" "))
      const inputPart = boundedJson(state.input ?? {}, INPUT_INDEX_BUDGET)
      if (state.status === "error") {
        const errorText = typeof state.error === "string" ? state.error : boundedJson(state.error)
        const composed = `${part.tool} ${inputPart} ${previewOutputForIndex(errorText)} ${attachments}`.trim()
        return { kind: "tool_error", body: finalizeToolBody(part.tool, errorText, composed), tool_name: part.tool }
      }
      if (state.status === "completed") {
        const outputText = typeof state.output === "string" ? state.output : boundedJson(state.output ?? "")
        const composed = `${part.tool} ${inputPart} ${previewOutputForIndex(outputText)} ${attachments}`.trim()
        return { kind: "tool_output", body: finalizeToolBody(part.tool, outputText, composed), tool_name: part.tool }
      }
      return null
    }
    case "subtask":
      return {
        kind: "subtask",
        body: previewForIndex([part.prompt, part.description, part.agent, part.command].filter(Boolean).join(" ")),
        tool_name: null,
      }
    case "compaction": {
      const body = [part.projection?.summary, part.projection?.manifest].filter(Boolean).join(" ")
      return body ? { kind: "compaction", body: previewForIndex(body), tool_name: null } : null
    }
    case "patch":
      return part.files.length ? { kind: "patch", body: previewForIndex(part.files.join(" ")), tool_name: null } : null
    case "agent":
      return {
        kind: "agent",
        body: previewForIndex([part.name, part.source?.value].filter(Boolean).join(" ")),
        tool_name: null,
      }
    case "retry":
      return {
        kind: "retry",
        body: previewForIndex(part.message),
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
