export function computeCacheHitRate(
  messages: Array<{ role: string; tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }>,
): number {
  let totalInput = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const item of messages) {
    if (item.role !== "assistant") continue
    const t = item.tokens
    totalInput += t.input + t.output + t.reasoning + t.cache.read + t.cache.write
    cacheRead += t.cache.read
    cacheWrite += t.cache.write
  }
  const billable = totalInput - cacheRead - cacheWrite
  const denom = cacheRead + Math.max(billable, 0)
  return denom > 0 ? cacheRead / denom : 0
}

export function formatCacheHitRate(rate: number): string | null {
  if (rate === 0) return null
  return `${(rate * 100).toFixed(1)}% cache hit`
}
