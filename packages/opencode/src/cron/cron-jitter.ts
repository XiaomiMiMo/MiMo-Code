import { computeNextCronRun } from "./cron-expr"

export type JitterConfig = {
  recurringFrac: number
  recurringCapMs: number
  oneShotMaxMs: number
  oneShotFloorMs: number
  oneShotMinuteMod: number
  recurringMaxAgeMs: number
  cacheLeadMs: number
}

export const DEFAULT_JITTER: JitterConfig = {
  recurringFrac: 0.5,
  recurringCapMs: 1_800_000,
  oneShotMaxMs: 90_000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  cacheLeadMs: 15_000,
}

const CACHE_CLIFF_MINUTES = 5
const EVERY_N_MIN = /^\*\/\d+ \* \* \* \*$/

const hashUnit = (s: string): number => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0
  return (h % 1_000_000) / 1_000_000
}

const nextRunMs = (cron: string, fromMs: number): number | null => {
  const d = computeNextCronRun(cron, new Date(fromMs))
  return d?.getTime() ?? null
}

export const jitteredNextCronRunMs = (
  cron: string, fromMs: number, taskId: string, cfg: JitterConfig = DEFAULT_JITTER,
): number | null => {
  const first = nextRunMs(cron, fromMs)
  if (first === null) return null
  const onCacheCliff = EVERY_N_MIN.test(cron)
    && cfg.cacheLeadMs > 0
    && new Date(first).getUTCMinutes() % CACHE_CLIFF_MINUTES === 0
  if (onCacheCliff) {
    const pull = hashUnit(taskId) * cfg.cacheLeadMs
    const target = first - cfg.cacheLeadMs >= fromMs ? first : nextRunMs(cron, first)
    if (target === null) return first
    return target - pull
  }
  const followingMs = nextRunMs(cron, first)
  if (followingMs === null) return first
  const periodMs = followingMs - first
  const j = Math.min(hashUnit(taskId) * cfg.recurringFrac * periodMs, cfg.recurringCapMs)
  return first + j
}

export const oneShotJitteredNextCronRunMs = (
  cron: string, createdAtMs: number, taskId: string, cfg: JitterConfig = DEFAULT_JITTER,
): number | null => {
  const next = nextRunMs(cron, createdAtMs)
  if (next === null) return null
  if (new Date(next).getUTCMinutes() % cfg.oneShotMinuteMod !== 0) return next
  const pull = cfg.oneShotFloorMs + hashUnit(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs)
  return Math.max(next - pull, createdAtMs)
}
