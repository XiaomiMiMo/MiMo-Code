/**
 * Pure tool-result preview budget — shared by `Truncate.output` and history FTS.
 * No Log / Effect / filesystem imports so Node harnesses can load this path.
 */

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024

const ERROR_PATTERN = /error|exception|failed|fatal|traceback|panic|exit code/i
const TAIL_SCAN_CHARS = 2048
/** Upper bound for "...N lines/bytes omitted/truncated..." markers so head/tail content + marker ≤ maxBytes. */
const MARKER_RESERVE = 128

export type PreviewResult = { content: string; truncated: false } | { content: string; truncated: true }

export interface PreviewOptions {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail" | "head+tail"
  pressureCaps?: boolean
  outcome?: "success" | "error"
}

/** Take a UTF-8 prefix of `line` that fits in `maxBytes` (single-line giant outputs). */
function sliceLineToBytes(line: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (Buffer.byteLength(line, "utf-8") <= maxBytes) return line
  let end = 0
  let bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf-8")
    if (bytes + n > maxBytes) break
    bytes += n
    end += ch.length
  }
  return line.slice(0, end)
}

/**
 * Pure tool-result preview. Shared by `Truncate.output` (model-facing tool
 * results) and history FTS extract — same budget and head/tail policy.
 * Does not write files; `Truncate.output` adds the full-output path hint.
 *
 * Omission markers are included in the byte budget (`MARKER_RESERVE`), so
 * returned `content` stays within `maxBytes`.
 */
export function previewToolOutput(text: string, options: PreviewOptions = {}): PreviewResult {
  let maxLines = options.maxLines ?? MAX_LINES
  let maxBytes = options.maxBytes ?? MAX_BYTES
  const direction = options.direction ?? "head+tail"
  if (options.pressureCaps) {
    maxLines = Math.floor(maxLines / 2)
    maxBytes = Math.floor(maxBytes / 2)
  }

  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false }
  }

  // Content budget leaves room for the truncation/omission marker.
  const contentBytes = Math.max(0, maxBytes - MARKER_RESERVE)

  if (direction === "head+tail") {
    const tailScan = text.length > TAIL_SCAN_CHARS ? text.slice(-TAIL_SCAN_CHARS) : text
    const hasErrors = ERROR_PATTERN.test(tailScan)
    if (hasErrors) {
      const headMaxLines = Math.floor(maxLines * 0.7)
      const headMaxBytes = Math.floor(contentBytes * 0.7)
      const tailMaxLines = maxLines - headMaxLines
      const tailMaxBytes = contentBytes - headMaxBytes
      const headOut: string[] = []
      let headBytes = 0
      for (let i = 0; i < lines.length && headOut.length < headMaxLines; i++) {
        const size = Buffer.byteLength(lines[i]!, "utf-8") + (i > 0 ? 1 : 0)
        if (headBytes + size > headMaxBytes) {
          if (headOut.length === 0 && headMaxBytes > 0) {
            headOut.push(sliceLineToBytes(lines[i]!, headMaxBytes))
            headBytes = Buffer.byteLength(headOut[0]!, "utf-8")
          }
          break
        }
        headOut.push(lines[i]!)
        headBytes += size
      }
      const tailOut: string[] = []
      let tailBytes = 0
      for (let i = lines.length - 1; i >= 0 && tailOut.length < tailMaxLines; i--) {
        const size = Buffer.byteLength(lines[i]!, "utf-8") + (tailOut.length > 0 ? 1 : 0)
        if (tailBytes + size > tailMaxBytes) {
          if (tailOut.length === 0 && tailMaxBytes > 0) {
            const sliced = sliceLineToBytes(lines[i]!, tailMaxBytes)
            tailOut.unshift(sliced.length < lines[i]!.length ? `…${sliced}` : sliced)
            tailBytes = Buffer.byteLength(tailOut[0]!, "utf-8")
          }
          break
        }
        tailOut.unshift(lines[i]!)
        tailBytes += size
      }
      // Head/tail may both slice the same giant line; never emit a negative count.
      const omitted = Math.max(0, lines.length - headOut.length - tailOut.length)
      return {
        content: `${headOut.join("\n")}\n\n... ${omitted} lines omitted — showing head and tail ...\n\n${tailOut.join("\n")}`,
        truncated: true,
      }
    }
  }

  const out: string[] = []
  let bytes = 0
  let hitBytes = false
  if (direction === "head" || direction === "head+tail") {
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const size = Buffer.byteLength(lines[i]!, "utf-8") + (i > 0 ? 1 : 0)
      if (bytes + size > contentBytes) {
        // Single-line giants: keep a head slice instead of emitting only the marker.
        if (out.length === 0 && contentBytes > 0) {
          out.push(sliceLineToBytes(lines[i]!, contentBytes))
          bytes = Buffer.byteLength(out[0]!, "utf-8")
        }
        hitBytes = true
        break
      }
      out.push(lines[i]!)
      bytes += size
    }
    const removed = Math.max(0, hitBytes ? totalBytes - bytes : lines.length - out.length)
    const unit = hitBytes ? "bytes" : "lines"
    return {
      content: `${out.join("\n")}\n\n...${removed} ${unit} truncated...`,
      truncated: true,
    }
  }

  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i]!, "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > contentBytes) {
      if (out.length === 0 && contentBytes > 0) {
        const line = lines[i]!
        const sliced = sliceLineToBytes(line, contentBytes)
        out.unshift(sliced.length < line.length ? `…${sliced}` : sliced)
        bytes = Buffer.byteLength(out[0]!, "utf-8")
      }
      hitBytes = true
      break
    }
    out.unshift(lines[i]!)
    bytes += size
  }
  const removed = Math.max(0, hitBytes ? totalBytes - bytes : lines.length - out.length)
  const unit = hitBytes ? "bytes" : "lines"
  return {
    content: `...${removed} ${unit} truncated...\n\n${out.join("\n")}`,
    truncated: true,
  }
}
