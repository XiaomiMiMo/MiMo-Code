import type { Provider } from "@/provider"

export type ToolAttachment = {
  mime: string
  url: string
  filename?: string
}

export type ToolAttachmentRoute = "native" | "synthetic" | "placeholder"

const MAX_ATTACHMENT_NAME_LENGTH = 120
const SAFE_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const OPENAI_AUDIO_MIMES = new Set(["audio/wav", "audio/mp3", "audio/mpeg"])
const BEDROCK_TEXT_MIMES = new Set(["text/csv", "text/html", "text/plain", "text/markdown"])
const OPENAI_CHAT_PACKAGES = new Set(["@ai-sdk/openai-compatible"])
const ANTHROPIC_PACKAGES = new Set(["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"])
const GOOGLE_PACKAGES = new Set(["@ai-sdk/google", "@ai-sdk/google-vertex"])

function isGemini3(model: Provider.Model) {
  // Keep this aligned with @ai-sdk/google's functionResponse.parts gate.
  // Prefixed or case-variant IDs must use synthetic attachments; routing them
  // as native would make the provider serialize binary parts as legacy JSON.
  return model.api.id.startsWith("gemini-3")
}

function isInlineAttachment(attachment: ToolAttachment) {
  return inlineToolAttachment(attachment) !== undefined
}

function isRemoteURL(url: string) {
  return /^https?:\/\//i.test(url)
}

function modelAcceptsMime(model: Provider.Model, mime: string) {
  if (mime.startsWith("image/")) return SAFE_IMAGE_MIMES.has(mime) && model.capabilities.input.image
  if (mime === "application/pdf") return model.capabilities.input.pdf
  if (mime.startsWith("audio/")) return model.capabilities.input.audio
  if (mime.startsWith("video/")) return model.capabilities.input.video
  if (mime.startsWith("text/")) return model.capabilities.input.text
  return false
}

function providerAcceptsSynthetic(model: Provider.Model, attachment: ToolAttachment) {
  const npm = model.api.npm
  const mime = attachment.mime

  if (SAFE_IMAGE_MIMES.has(mime)) return isInlineAttachment(attachment) || isRemoteURL(attachment.url)
  if (mime === "application/pdf") return isInlineAttachment(attachment)
  if (mime.startsWith("audio/")) {
    if (!isInlineAttachment(attachment)) return false
    if (OPENAI_CHAT_PACKAGES.has(npm)) return OPENAI_AUDIO_MIMES.has(mime)
    return GOOGLE_PACKAGES.has(npm)
  }
  if (mime.startsWith("video/")) return isInlineAttachment(attachment) && GOOGLE_PACKAGES.has(npm)
  if (mime.startsWith("text/")) {
    if (!isInlineAttachment(attachment)) return false
    if (OPENAI_CHAT_PACKAGES.has(npm) || GOOGLE_PACKAGES.has(npm)) return true
    if (npm === "@ai-sdk/amazon-bedrock") return BEDROCK_TEXT_MIMES.has(mime)
    return ANTHROPIC_PACKAGES.has(npm) && mime === "text/plain"
  }
  return false
}

function providerAcceptsNative(model: Provider.Model, attachment: ToolAttachment) {
  if (!isInlineAttachment(attachment)) return false
  const npm = model.api.npm
  const mime = attachment.mime

  if (ANTHROPIC_PACKAGES.has(npm) || npm === "@ai-sdk/amazon-bedrock") {
    return SAFE_IMAGE_MIMES.has(mime) || mime === "application/pdf"
  }
  if (GOOGLE_PACKAGES.has(npm) && isGemini3(model)) {
    return (
      SAFE_IMAGE_MIMES.has(mime) || mime === "application/pdf" || mime.startsWith("audio/") || mime.startsWith("video/")
    )
  }
  return false
}

export function routeToolAttachment(input: {
  model: Provider.Model
  attachment: ToolAttachment
  allowNative: boolean
}): ToolAttachmentRoute {
  if (!modelAcceptsMime(input.model, input.attachment.mime)) return "placeholder"
  if (input.allowNative && providerAcceptsNative(input.model, input.attachment)) return "native"
  if (providerAcceptsSynthetic(input.model, input.attachment)) return "synthetic"
  return "placeholder"
}

export function inlineToolAttachment(attachment: ToolAttachment) {
  const match = attachment.url.match(/^data:([^;,]+);base64,([a-z0-9+/]+={0,2})$/i)
  if (!match) return undefined
  if (match[1].toLowerCase() !== attachment.mime.toLowerCase()) return undefined
  return {
    data: match[2],
    mediaType: attachment.mime,
  }
}

function boundedAttachmentName(filename: string) {
  const normalized = filename.trim()
  if (/^data:/i.test(normalized)) {
    const mime = normalized
      .slice(5)
      .split(/[;,]/, 1)[0]
      ?.replace(/[^a-z0-9.+/-]/gi, "")
      .slice(0, 80)
    return mime ? `data URI (${mime})` : "data URI"
  }

  let value = normalized
  try {
    const url = new URL(normalized)
    const segments = url.pathname.split("/").filter(Boolean)
    const tail = segments.at(-1)
    value = tail ? decodeURIComponent(tail) : url.hostname || url.protocol.slice(0, -1)
  } catch {
    value = normalized.split(/[\\/]/).at(-1) ?? normalized
    value = value.split(/[?#]/, 1)[0] ?? value
  }

  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replaceAll('"', "'")
    .replace(/\s+/g, " ")
    .trim()
  if (!clean) return "attachment"
  if (clean.length <= MAX_ATTACHMENT_NAME_LENGTH) return clean
  return `${clean.slice(0, MAX_ATTACHMENT_NAME_LENGTH - 3)}...`
}

export function toolAttachmentFilename(attachment: ToolAttachment) {
  if (!attachment.filename || /^data:/i.test(attachment.filename.trim())) return undefined
  const safe = boundedAttachmentName(attachment.filename)
    .replace(/[^a-z0-9 .()-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[ .-]+|[ .-]+$/g, "")
  return safe || undefined
}

export function toolAttachmentPlaceholder(attachment: ToolAttachment) {
  const name = attachment.filename ? `"${boundedAttachmentName(attachment.filename)}"` : "an unnamed attachment"
  const mime = attachment.mime.replace(/[^a-z0-9.+/-]/gi, "").slice(0, 80) || "unknown"
  return `[Tool attachment ${name} (${mime}) was retained but cannot be safely sent to this model/provider.]`
}
