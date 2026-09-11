import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { isRecord } from "@/util/record"
import { base64ByteSize, classifyAttachment, oversizedAttachmentNotice } from "@/util/media"
import { shrinkAttachment } from "@/provider/image"

export type ToolResultAttachment = {
  mime: string
  url: string
  filename?: string
}

export type ToolResultMetadata = {
  isError: boolean
  structuredContent?: CallToolResult["structuredContent"]
  _meta?: CallToolResult["_meta"]
  legacyMetadata?: Record<string, unknown>
}

export type NormalizedToolResult = {
  content: CallToolResult["content"]
  structuredContent?: CallToolResult["structuredContent"]
  isError: boolean
  output: string
  attachments: ToolResultAttachment[]
  metadata: Record<string, unknown> & { mcp: ToolResultMetadata }
}

function containsSerializedBlock(output: string, serialized: string) {
  const value = output.replaceAll("\r\n", "\n").trim()
  return (
    value === serialized ||
    value.startsWith(`${serialized}\n`) ||
    value.endsWith(`\n${serialized}`) ||
    value.includes(`\n${serialized}\n`)
  )
}

/**
 * Converts a standard MCP CallToolResult into MiMoCode's model-facing text,
 * attachments, and lossless client metadata.
 *
 * MCP servers should normally include a serialized copy of `structuredContent`
 * in `content`. When they do not, the structured value is appended so it still
 * reaches the model; exact compact or pretty-printed copies are de-duplicated.
 * Top-level `_meta` is client-only and is never added to output text.
 */
export function normalizeToolResult(result: CallToolResult): NormalizedToolResult {
  const text: string[] = []
  const attachments: ToolResultAttachment[] = []
  // Inline payloads are bounded here, at the tool result boundary, so nothing
  // over the attachment limit reaches the session DB or the model. The size is
  // classified O(1) on the base64 length (see classifyAttachment); only an
  // oversized image within the source ceiling is decoded and recompressed.
  const fit = (label: string, mime: string, base64: string) => {
    const size = base64ByteSize(base64)
    const verdict = classifyAttachment(mime, size)
    if (verdict === "fits") return { mime, base64 }
    const fitted = verdict === "shrink" ? shrinkAttachment(mime, Buffer.from(base64, "base64")) : undefined
    if (fitted) return { mime: fitted.mime, base64: fitted.base64 }
    text.push(oversizedAttachmentNotice({ label, size, compressed: verdict === "shrink", hint: "It was dropped." }))
    return undefined
  }

  for (const item of result.content) {
    if (item.type === "text") {
      text.push(item.text)
      continue
    }

    if (item.type === "image" || item.type === "audio") {
      const fitted = fit(item.mimeType, item.mimeType, item.data)
      if (!fitted) continue
      attachments.push({
        mime: fitted.mime,
        url: `data:${fitted.mime};base64,${fitted.base64}`,
      })
      continue
    }

    if (item.type === "resource_link") {
      const name = item.title ?? item.name
      const uri = item.uri.trim()
      if (/^data:/i.test(uri)) {
        const inline = uri.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i)
        if (inline) {
          const fitted = fit(`"${name}" (${inline[1]})`, inline[1], inline[2])
          if (!fitted) continue
          attachments.push({
            mime: fitted.mime,
            url: fitted.mime === inline[1] ? uri : `data:${fitted.mime};base64,${fitted.base64}`,
            filename: name,
          })
          text.push(`${name}: [inline ${inline[1]} resource]`)
        } else {
          text.push(`${name}: [data URI omitted]`)
        }
        continue
      }
      text.push(`${name}: ${item.uri}`)
      continue
    }

    if (item.type === "resource") {
      if ("text" in item.resource) text.push(item.resource.text)
      if ("blob" in item.resource) {
        const mime = item.resource.mimeType ?? "application/octet-stream"
        const fitted = fit(`"${item.resource.uri}" (${mime})`, mime, item.resource.blob)
        if (!fitted) continue
        attachments.push({
          mime: fitted.mime,
          url: `data:${fitted.mime};base64,${fitted.base64}`,
          filename: item.resource.uri,
        })
      }
    }
  }

  const legacy = isRecord(result.metadata) ? result.metadata : {}
  const textOutput = text.join("\n\n")
  const structured =
    result.structuredContent === undefined ? undefined : JSON.stringify(result.structuredContent)
  const prettyStructured =
    result.structuredContent === undefined ? undefined : JSON.stringify(result.structuredContent, null, 2)
  const hasVisibleText = text.some((item) => item.trim().length > 0)
  const alreadySerialized =
    structured !== undefined &&
    (containsSerializedBlock(textOutput, structured) ||
      (prettyStructured !== undefined && containsSerializedBlock(textOutput, prettyStructured)))
  const output =
    structured === undefined || alreadySerialized
      ? textOutput
      : hasVisibleText
        ? `${textOutput}\n\nStructured content:\n${structured}`
        : structured

  const mcp: ToolResultMetadata = {
    isError: result.isError ?? false,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    ...(result._meta === undefined ? {} : { _meta: result._meta }),
    ...(Object.keys(legacy).length === 0 ? {} : { legacyMetadata: legacy }),
  }

  return {
    content: result.content,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    isError: result.isError ?? false,
    output,
    attachments,
    metadata: { mcp },
  }
}
