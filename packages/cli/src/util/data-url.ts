export function decodeDataUrl(url: string) {
  const idx = url.indexOf(",")
  if (idx === -1) return ""

  const head = url.slice(0, idx)
  const body = url.slice(idx + 1)
  // The `;base64` token is case-insensitive per RFC 2397, and the media type
  // and parameters that precede it may be written in any case too.
  if (head.toLowerCase().includes(";base64")) return Buffer.from(body, "base64").toString("utf8")
  try {
    return decodeURIComponent(body)
  } catch {
    // A percent that does not introduce a valid escape (`100%`, `a%zz`) makes
    // decodeURIComponent throw URIError. Attachments reach here straight from
    // the message part, whose `url` is an unvalidated string, so throwing would
    // fail the whole turn over one malformed attachment. Fall back to the raw
    // body: it is what the sender wrote, minus the percent-decoding.
    return body
  }
}
