const HAN = /\p{Script=Han}/u
const WORD = /[\p{L}\p{N}]/u

function indexText(body: string) {
  const parts: string[] = []
  const inserted = new Set<number>()
  let previous = ""
  let offset = 0
  for (const char of body) {
    if ((HAN.test(previous) && WORD.test(char)) || (WORD.test(previous) && HAN.test(char))) {
      inserted.add(offset++)
      parts.push(" ")
    }
    parts.push(char)
    offset += char.length
    previous = char
  }
  return { text: parts.join(""), inserted }
}

/** Isolate Han characters while retaining the original whitespace for snippets. */
export function buildSearchIndexText(body: string): string {
  return indexText(body).text
}

// Internal FTS markers differ from the public << >> / ... presentation.
export const SNIPPET_START = "\u0001"
export const SNIPPET_END = "\u0002"
export const SNIPPET_ELLIPSIS = "\u0003"

/** Remove only generated separators; original spaces, punctuation and lines survive. */
export function restoreSearchSnippet(body: string, snippet: string): string {
  const index = indexText(body)
  const fragment = snippet.replaceAll(SNIPPET_START, "").replaceAll(SNIPPET_END, "").replaceAll(SNIPPET_ELLIPSIS, "")
  let offset = index.text.indexOf(fragment)
  const parts: string[] = []
  for (const char of snippet) {
    if (char === SNIPPET_START) parts.push("<<")
    else if (char === SNIPPET_END) parts.push(">>")
    else if (char === SNIPPET_ELLIPSIS) parts.push("...")
    else {
      if (!index.inserted.has(offset)) parts.push(char)
      offset += char.length
    }
  }
  return parts.join("")
}
