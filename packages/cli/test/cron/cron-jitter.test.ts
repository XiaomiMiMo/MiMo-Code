import { test, expect } from "bun:test"
import { DEFAULT_JITTER, jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from "@/cron/cron-jitter"

test("jittered next run is deterministic per task id", () => {
  const from = new Date("2026-06-29T12:00:00Z").getTime()
  const a = jitteredNextCronRunMs("*/5 * * * *", from, "task-a")
  const b = jitteredNextCronRunMs("*/5 * * * *", from, "task-a")
  expect(a).toBe(b)
})

test("jittered next run differs across task ids", () => {
  const from = new Date("2026-06-29T12:00:00Z").getTime()
  const a = jitteredNextCronRunMs("*/5 * * * *", from, "task-a")
  const b = jitteredNextCronRunMs("*/5 * * * *", from, "task-b")
  expect(a).not.toBe(b)
})

test("cacheLeadMs pulls fire up to 15s early for */N near 5-min cliff", () => {
  const from = new Date("2026-06-29T11:59:50Z").getTime()
  const raw = new Date("2026-06-29T12:05:00Z").getTime()
  const next = jitteredNextCronRunMs("*/5 * * * *", from, "x", {
    ...DEFAULT_JITTER, recurringFrac: 0, recurringCapMs: 0,
  })
  expect(next).not.toBeNull()
  expect(next!).toBeLessThanOrEqual(raw)
  expect(raw - next!).toBeLessThanOrEqual(15000)
})

test("oneShot ≤90s early only on :00 / :30 minute marks", () => {
  const created = new Date("2026-06-29T12:00:00Z").getTime()
  const onShot = oneShotJitteredNextCronRunMs("0 9 30 6 *", created, "x")
  const offShot = oneShotJitteredNextCronRunMs("17 9 30 6 *", created, "x")
  const onRaw = new Date("2026-06-30T09:00:00Z").getTime()
  const offRaw = new Date("2026-06-30T09:17:00Z").getTime()
  expect(onShot).not.toBeNull()
  expect(onRaw - onShot!).toBeGreaterThanOrEqual(0)
  expect(onRaw - onShot!).toBeLessThanOrEqual(90_000)
  expect(offShot).toBe(offRaw)
})
