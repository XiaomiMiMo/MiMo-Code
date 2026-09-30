import { Token } from "../../../../../util"

const MIN_STREAMING_ELAPSED_SEC = 0.5
const MIN_COMPLETED_ELAPSED_SEC = 0.001

export function streamingTPS(combinedText: string, startedAt: number, now: number): number | null {
  const tokens = Token.estimate(combinedText)
  if (tokens === 0) return null
  const elapsedSec = (now - startedAt) / 1000
  if (elapsedSec < MIN_STREAMING_ELAPSED_SEC) return null
  return tokens / elapsedSec
}

export function completedTPS(
  outputTokens: number,
  reasoningTokens: number,
  startedAt: number,
  completedAt: number,
): number | null {
  const tokens = outputTokens + reasoningTokens
  if (tokens === 0) return null
  const elapsedSec = (completedAt - startedAt) / 1000
  if (elapsedSec < MIN_COMPLETED_ELAPSED_SEC) return null
  return tokens / elapsedSec
}

export function formatTPS(tps: number | null): string | null {
  if (tps === null) return null
  if (tps < 1) return "<1 t/s"
  return `${Math.round(tps)} t/s`
}
