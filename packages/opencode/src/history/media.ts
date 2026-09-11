export type Attachment = { id: string; mime: string; url: string; filename?: string }

// Forward-only scans recognize explicit base64 data URLs, never ordinary long tokens.
export function cleanDataUrls(text: string, attachments?: Attachment[]) {
  const chunks: string[] = []
  let cursor = 0
  let ordinal = attachments?.length ?? 0
  const marker = /data:/gi
  const headerEnd = /[^a-z0-9!#$&^_.+%/=;-]/gi
  const outside = /[^\x2b-\x7a]/
  const punctuation = /[\x2c-\x2e\x3a-\x40\x5b-\x60]/
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    const index = match.index
    headerEnd.lastIndex = index + 5
    const comma = headerEnd.exec(text)?.index ?? text.length
    const fields = text.slice(index + 5, comma).split(";")
    const mime = fields[0] || "text/plain"
    if (
      text[comma] !== "," ||
      fields.length < 2 ||
      fields.at(-1)?.toLowerCase() !== "base64" ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime) ||
      fields.slice(1, -1).some((x) => !x.includes("="))
    ) {
      chunks.push(text.slice(cursor, index + 5))
      cursor = index + 5
      continue
    }
    let end = comma + 1
    // Splitting the exact alphabet complement avoids JSC's slow mixed-case scan on high-entropy payloads.
    while (end < text.length) {
      const block = text.slice(end, end + 65536)
      const a = block.search(outside)
      const b = block.search(punctuation)
      if (a < 0 && b < 0) {
        end += block.length
        continue
      }
      end += a < 0 ? b : b < 0 ? a : Math.min(a, b)
      break
    }
    const size = end - comma - 1
    const padding = text[end] === "=" ? (text[end + 1] === "=" ? 2 : 1) : 0
    const tail = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(text[end - 1])
    if (
      size === 0 ||
      size % 4 === 1 ||
      (padding > 0 && (size + padding) % 4 !== 0) ||
      (size % 4 === 2 && (tail & 15) !== 0) ||
      (size % 4 === 3 && (tail & 3) !== 0) ||
      text[end + padding] === "="
    ) {
      chunks.push(text.slice(cursor, index + 5))
      cursor = index + 5
      continue
    }
    end += padding
    const id = `inline:${ordinal++}`
    attachments?.push({ id, mime, url: text.slice(index, end) })
    chunks.push(
      text.slice(cursor, index),
      `[media ${mime}; ${attachments ? `attachment=${id}; call history get attachment=${id}` : "omitted; use history get"}]`,
    )
    cursor = end
    marker.lastIndex = end
  }
  chunks.push(text.slice(cursor))
  return chunks.join("")
}

type Data = {
  type: string
  text?: string
  tool?: string
  mime?: string
  url?: string
  filename?: string
  state?: {
    input?: unknown
    output?: unknown
    error?: string
    attachments?: { mime: string; url: string; filename?: string }[]
  }
}

export function detail(data: Data, collect = true) {
  const attachments: Attachment[] = []
  const clean = (value: string) => cleanDataUrls(value, collect ? attachments : undefined)
  const json = (value: unknown) =>
    clean(JSON.stringify(value, (_key, item: unknown) => (typeof item === "string" ? clean(item) : item)))
  const text =
    data.type === "text" || data.type === "reasoning"
      ? clean(data.text ?? "")
      : data.type === "tool"
        ? `tool: ${clean(data.tool ?? "")}\ninput: ${json(data.state?.input ?? {})}\noutput: ${json(data.state?.output ?? "")}\nerror: ${clean(data.state?.error ?? "")}`
        : `[${data.type}]`
  const inlineCount = attachments.length
  if (data.type === "file" && data.url)
    attachments.push({
      id: "file:0",
      mime: data.mime ?? "application/octet-stream",
      url: data.url,
      filename: data.filename,
    })
  data.state?.attachments?.forEach((a, i) =>
    attachments.push({ id: `tool:${i}`, mime: a.mime, url: a.url, filename: a.filename }),
  )
  return {
    text:
      text +
      attachments
        .slice(inlineCount)
        .map((a) => `\n[media ${cleanDataUrls(a.mime)}; attachment=${a.id}; use history get]`)
        .join(""),
    attachments: collect ? attachments : [],
  }
}

// Reserve space in the 20KiB envelope for metadata and a 2KB attachment directory.
export function page(text: string, offset = 0, length = 4000, bytes = 16000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new Error("offset must be a non-negative UTF-16 cursor within total_length")
  if (!Number.isSafeInteger(length) || length < 1 || length > 8000)
    throw new Error("length must be an integer between 1 and 8000")
  const split = (i: number) =>
    i > 0 &&
    i < text.length &&
    text.charCodeAt(i) >= 0xdc00 &&
    text.charCodeAt(i) <= 0xdfff &&
    text.charCodeAt(i - 1) >= 0xd800 &&
    text.charCodeAt(i - 1) <= 0xdbff
  if (split(offset)) throw new Error("offset splits a surrogate pair; use next_offset")
  let end = Math.min(text.length, offset + length)
  if (split(end)) end = end === offset + 1 ? end + 1 : end - 1
  while (Buffer.byteLength(text.slice(offset, end)) > bytes) {
    end = offset + Math.floor((end - offset) * 0.9)
    if (split(end)) end--
  }
  return {
    text: text.slice(offset, end),
    offset,
    next_offset: end,
    total_length: text.length,
    has_more: end < text.length,
  }
}

export function summary(text: string) {
  const result = page(cleanDataUrls(text), 0, 1000, 3000)
  return result.text + (result.has_more ? "\n[omitted; use history get part_id]" : "")
}
