import { test, expect, describe } from "bun:test"
import { computeCacheHitRate, formatCacheHitRate } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/cache"

function msg(role: string, input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number) {
  return { role, tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } } }
}

describe("computeCacheHitRate", () => {
  test("returns 0 when no assistant messages", () => {
    expect(computeCacheHitRate([msg("user", 100, 0, 0, 0, 0)])).toBe(0)
  })

  test("returns 0 when empty array", () => {
    expect(computeCacheHitRate([])).toBe(0)
  })

  test("returns 0 when no cache hits", () => {
    expect(computeCacheHitRate([msg("assistant", 100, 50, 0, 0, 0)])).toBe(0)
  })

  test("computes hit rate with cache reads", () => {
    // totalInput = 100 + 50 + 0 + 80 + 0 = 230
    // billable = 230 - 80 - 0 = 150
    // denom = 80 + 150 = 230
    // hitRate = 80 / 230 ≈ 0.3478
    const rate = computeCacheHitRate([msg("assistant", 100, 50, 0, 80, 0)])
    expect(rate).toBeCloseTo(80 / 230, 5)
  })

  test("computes hit rate with cache reads and writes", () => {
    // totalInput = 200 + 100 + 0 + 150 + 50 = 500
    // billable = 500 - 150 - 50 = 300
    // denom = 150 + 300 = 450
    // hitRate = 150 / 450 = 0.3333
    const rate = computeCacheHitRate([msg("assistant", 200, 100, 0, 150, 50)])
    expect(rate).toBeCloseTo(150 / 450, 5)
  })

  test("aggregates across multiple assistant messages", () => {
    const messages = [
      msg("assistant", 100, 50, 0, 80, 0),
      msg("assistant", 200, 100, 0, 150, 50),
    ]
    // totalInput = (100+50+0+80+0) + (200+100+0+150+50) = 230 + 500 = 730
    // cacheRead = 80 + 150 = 230
    // cacheWrite = 0 + 50 = 50
    // billable = 730 - 230 - 50 = 450
    // denom = 230 + 450 = 680
    // hitRate = 230 / 680
    const rate = computeCacheHitRate(messages)
    expect(rate).toBeCloseTo(230 / 680, 5)
  })

  test("100% cache hit when all input is cached", () => {
    // totalInput = 0 + 0 + 0 + 100 + 0 = 100
    // billable = 100 - 100 - 0 = 0
    // denom = 100 + 0 = 100
    // hitRate = 100 / 100 = 1
    const rate = computeCacheHitRate([msg("assistant", 0, 0, 0, 100, 0)])
    expect(rate).toBe(1)
  })

  test("reasoning tokens are included in total input", () => {
    // totalInput = 0 + 0 + 50 + 30 + 0 = 80
    // billable = 80 - 30 - 0 = 50
    // denom = 30 + 50 = 80
    // hitRate = 30 / 80
    const rate = computeCacheHitRate([msg("assistant", 0, 0, 50, 30, 0)])
    expect(rate).toBeCloseTo(30 / 80, 5)
  })
})

describe("formatCacheHitRate", () => {
  test("returns null when rate is 0", () => {
    expect(formatCacheHitRate(0)).toBeNull()
  })

  test("formats rate with one decimal place", () => {
    expect(formatCacheHitRate(0.723)).toBe("72.3% cache hit")
  })

  test("formats 100% hit rate", () => {
    expect(formatCacheHitRate(1)).toBe("100.0% cache hit")
  })

  test("formats small rate correctly", () => {
    expect(formatCacheHitRate(0.005)).toBe("0.5% cache hit")
  })
})
