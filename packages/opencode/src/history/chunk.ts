export const CHUNK_BODY_MAX = 48_000
export const CHUNK_MAX = 24
export const CHUNK_OMIT = "\n[history-index: further chunks omitted; use history get]"

export function basePartId(partId: string): string {
  const hash = partId.lastIndexOf("#")
  if (hash <= 0) return partId
  return /^#\d+$/.test(partId.slice(hash)) ? partId.slice(0, hash) : partId
}

export function chunkId(partId: string, index: number, total: number): string {
  if (total <= 1) return partId
  return `${partId}#${index}`
}

/** Prefer newline boundaries, then whitespace, else hard cut. */
export function splitBody(body: string, max = CHUNK_BODY_MAX): string[] {
  if (body.length <= max) return [body]
  const parts: string[] = []
  let rest = body
  while (rest.length > 0) {
    if (rest.length <= max) {
      parts.push(rest)
      break
    }
    const window = rest.slice(0, max)
    const nl = window.lastIndexOf("\n")
    const ws = nl >= 0 ? -1 : window.lastIndexOf(" ")
    const cut = nl >= 64 ? nl + 1 : ws >= 64 ? ws + 1 : max
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  return parts
}

export function chunkBody(body: string, max = CHUNK_BODY_MAX, maxChunks = CHUNK_MAX): string[] {
  const all = splitBody(body, max)
  if (all.length <= maxChunks) return all
  const kept = all.slice(0, maxChunks)
  const last = kept[maxChunks - 1]!
  kept[maxChunks - 1] = last + CHUNK_OMIT
  return kept
}

export function likeEscape(value: string): string {
  return value.replaceAll(/[\\%_]/g, (c) => `\\${c}`)
}

/** SQL LIKE pattern matching this part's chunk rows (including the bare id). */
export function chunkLikePattern(partId: string): string {
  return `${likeEscape(partId)}#%`
}
