const CHARS_PER_TOKEN = 4

export function estimate(input: string) {
  return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
}

// Parse a token quantity: plain number, "100K"/"1.5M" (case-insensitive), or
// "40%" of `relativeTo`. Returns undefined when the input is not a valid
// quantity so callers can pick their own error handling.
export function parseQuantity(input: number | string, relativeTo?: number): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? Math.floor(input) : undefined
  const trimmed = input.trim()
  if (trimmed.endsWith("%")) {
    if (relativeTo === undefined) return undefined
    const pct = parseFloat(trimmed.slice(0, -1))
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return undefined
    return Math.floor((relativeTo * pct) / 100)
  }
  const match = trimmed.match(/^(\d+(?:\.\d+)?)([KkMm]?)$/)
  if (!match) return undefined
  const scale = match[2] === "" ? 1 : match[2].toLowerCase() === "k" ? 1_000 : 1_000_000
  return Math.floor(parseFloat(match[1]) * scale)
}

// Compact token count for display: 300000 -> "300K", 1050000 -> "1.05M".
export function format(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return `${value}`
}
