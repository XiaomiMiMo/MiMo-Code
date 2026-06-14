// Build an FTS5 MATCH expression from a free-form user query.
// Tokenize on non-word boundaries (preserving CJK / Unicode letters and digits),
// wrap each token in phrase quotes, AND-join. Returns null when no usable tokens.
//
// Independent copy from memory/fts-query.ts so the two modules can evolve apart.
export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? []
  if (tokens.length === 0) return null
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`)
  return quoted.join(" AND ")
}
