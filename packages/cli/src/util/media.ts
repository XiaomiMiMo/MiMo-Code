import { Flag } from "@/flag/flag"

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isAudioAttachment(mime: string) {
  return mime.startsWith("audio/")
}

export function isVideoAttachment(mime: string) {
  return mime.startsWith("video/")
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isAudioAttachment(mime) || isVideoAttachment(mime) || isPdfAttachment(mime)
}

export function isImageAttachment(mime: string) {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

// Finite allowlists for the read tool. Prefix matching is unsafe: mime-types
// maps code extensions such as .ts/.mts to video/mp2t. Deliberately narrower
// than the full MiMo API surface — only the familiar formats the agent is
// expected to attach. Unknown media MIMEs never enter an attachment branch.
export const READ_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
export const READ_PDF_MIMES = new Set(["application/pdf"])
export const READ_AUDIO_MIMES = new Set(["audio/wav", "audio/x-wav", "audio/mp3", "audio/mpeg"])
export const READ_VIDEO_MIMES = new Set(["video/mp4"])

export function isReadImageMime(mime: string) {
  return READ_IMAGE_MIMES.has(mime)
}

export function isReadPdfMime(mime: string) {
  return READ_PDF_MIMES.has(mime)
}

export function isReadAudioMime(mime: string) {
  return READ_AUDIO_MIMES.has(mime)
}

export function isReadVideoMime(mime: string) {
  return READ_VIDEO_MIMES.has(mime)
}

export function isReadAttachmentMime(mime: string) {
  return isReadImageMime(mime) || isReadPdfMime(mime) || isReadAudioMime(mime) || isReadVideoMime(mime)
}

// Prefix media-likeness, for "outside the finite list but still looks like
// media" messaging only. Never use this to decide a successful attach.
export function looksLikeMediaMime(mime: string) {
  return mime.startsWith("image/") || isAudioAttachment(mime) || isVideoAttachment(mime) || isPdfAttachment(mime)
}

export function readMimeAllowlist(mime: string): ReadonlySet<string> | undefined {
  if (isReadImageMime(mime) || mime.startsWith("image/")) return READ_IMAGE_MIMES
  if (isReadAudioMime(mime) || mime.startsWith("audio/")) return READ_AUDIO_MIMES
  if (isReadVideoMime(mime) || mime.startsWith("video/")) return READ_VIDEO_MIMES
  if (isPdfAttachment(mime)) return READ_PDF_MIMES
  return undefined
}

// Inline audio/video is sent as a `data:{mime};base64,...` string, and the
// provider bounds the ENCODED string (50 MB for both the MiMo audio and video
// APIs), not the decoded bytes. Base64 grows the payload by 4/3, so a file must
// stay under ~37.5 MB on disk to fit. Checked on the stat size, before any
// bytes are read.
export const MAX_MEDIA_BASE64_BYTES = 50 * 1024 * 1024

export function base64Length(size: number) {
  return Math.ceil(size / 3) * 4
}

export function fitsMediaBase64(size: number) {
  return base64Length(size) <= MAX_MEDIA_BASE64_BYTES
}

export function oversizedMediaNotice(input: { label: string; size: number; hint: string }) {
  return `Attachment ${input.label} is ${input.size} bytes, which encodes to ${base64Length(input.size)} bytes of base64, over the ${mb(MAX_MEDIA_BASE64_BYTES)} inline media limit. ${input.hint}`
}

export function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x41, 0x56, 0x45])) {
    return "audio/wav"
  }

  return fallback
}

// Attachment size gate, driven by Flag.MIMOCODE_MAX_ATTACHMENT_SIZE and
// Flag.MIMOCODE_MAX_ATTACHMENT_SOURCE_SIZE. Enforced where the attachment is
// produced (read tool, user prompt attachments, MCP result normalization) on a
// size known up front (stat or base64 length), so nothing over the limit
// reaches the session DB:
//   fits    — under the limit, attach as-is
//   shrink  — an image over the limit but under the source ceiling: read it
//             and recompress under the limit, reject only if that fails
//   reject  — anything else over the limit (non-image, or an image so large
//             that recompressing it is not worth attempting)
// Audio and video never enter this gate: the provider bounds their ENCODED
// size, so they are checked with fitsMediaBase64 / MAX_MEDIA_BASE64_BYTES only.

// Decoded byte count of raw base64, O(1) — no decoding needed to classify.
export function base64ByteSize(base64: string) {
  if (!base64) return 0
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

export function classifyAttachment(mime: string, size: number): "fits" | "shrink" | "reject" {
  if (size <= Flag.MIMOCODE_MAX_ATTACHMENT_SIZE) return "fits"
  if (!mime.startsWith("image/")) return "reject"
  return size > Flag.MIMOCODE_MAX_ATTACHMENT_SOURCE_SIZE ? "reject" : "shrink"
}

function mb(bytes: number) {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`
}

// Notice for a rejected attachment. `compressed: true` means a shrink was
// attempted and failed; otherwise the payload was refused on size alone and
// the notice says why (over the source ceiling, or not an image).
export function oversizedAttachmentNotice(input: { label: string; size: number; compressed?: boolean; hint: string }) {
  const limit = mb(Flag.MIMOCODE_MAX_ATTACHMENT_SIZE)
  const reason = input.compressed
    ? "it could not be compressed under the limit"
    : input.size > Flag.MIMOCODE_MAX_ATTACHMENT_SOURCE_SIZE
      ? `it is also over the ${mb(Flag.MIMOCODE_MAX_ATTACHMENT_SOURCE_SIZE)} ceiling above which compression is not attempted`
      : "it cannot be compressed"
  return `Attachment ${input.label} is ${input.size} bytes, over the ${limit} attachment limit, and ${reason}. ${input.hint}`
}
