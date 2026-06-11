import { test, expect, describe } from "bun:test"
import { streamingTPS, completedTPS, formatTPS } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/tps"

describe("streamingTPS", () => {
  test("returns null when combined text is empty", () => {
    expect(streamingTPS("", 1000, 5000)).toBeNull()
  })

  test("returns null when elapsed < 0.5s", () => {
    // 800 chars → 200 estimated tokens, elapsed 0.4s
    expect(streamingTPS("a".repeat(800), 1000, 1400)).toBeNull()
  })

  test("returns null when elapsed exactly 0", () => {
    expect(streamingTPS("a".repeat(800), 1000, 1000)).toBeNull()
  })

  test("computes tokens / elapsedSec when valid", () => {
    // 800 chars → 200 estimated tokens, elapsed 2.0s → 100 t/s
    expect(streamingTPS("a".repeat(800), 1000, 3000)).toBe(100)
  })

  test("very small token count above the elapsed threshold still returns positive", () => {
    // 4 chars → 1 estimated token, elapsed 1s → 1 t/s
    expect(streamingTPS("abcd", 0, 1000)).toBe(1)
  })
})

describe("completedTPS", () => {
  test("returns null when output + reasoning is 0", () => {
    expect(completedTPS(0, 0, 1000, 5000)).toBeNull()
  })

  test("returns null when elapsedSec < 0.001 (zero-duration message)", () => {
    expect(completedTPS(100, 0, 1000, 1000)).toBeNull()
  })

  test("sums output and reasoning, divides by elapsed seconds", () => {
    // 200 + 100 = 300 tokens / 3s = 100 t/s
    expect(completedTPS(200, 100, 1000, 4000)).toBe(100)
  })

  test("reasoning-only turn (output == 0, reasoning > 0) still computes", () => {
    // 0 + 50 = 50 tokens / 2s = 25 t/s
    expect(completedTPS(0, 50, 1000, 3000)).toBe(25)
  })
})

describe("formatTPS", () => {
  test("returns null when input is null", () => {
    expect(formatTPS(null)).toBeNull()
  })

  test("renders <1 t/s when 0 < tps < 1", () => {
    expect(formatTPS(0.4)).toBe("<1 t/s")
  })

  test("rounds positive values to integer", () => {
    expect(formatTPS(42.6)).toBe("43 t/s")
    expect(formatTPS(42.4)).toBe("42 t/s")
    expect(formatTPS(1)).toBe("1 t/s")
  })
})
