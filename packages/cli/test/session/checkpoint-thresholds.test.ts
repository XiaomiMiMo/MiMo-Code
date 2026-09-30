import { describe, expect, test } from "bun:test"
import { parseThreshold, resolveThresholds } from "../../src/session/prune"

describe("parseThreshold", () => {
  test("parses percentage", () => {
    expect(parseThreshold("40%", 200_000)).toBe(80_000)
    expect(parseThreshold("50.5%", 200_000)).toBe(101_000)
    expect(parseThreshold("100%", 200_000)).toBe(200_000)
  })

  test("parses kilotokens (K/k)", () => {
    expect(parseThreshold("100K", 200_000)).toBe(100_000)
    expect(parseThreshold("100k", 200_000)).toBe(100_000)
    expect(parseThreshold("1.5K", 200_000)).toBe(1_500)
  })

  test("parses megatokens (M/m)", () => {
    expect(parseThreshold("1M", 2_000_000)).toBe(1_000_000)
    expect(parseThreshold("1.5M", 2_000_000)).toBe(1_500_000)
    expect(parseThreshold("1.5m", 2_000_000)).toBe(1_500_000)
  })

  test("parses plain numbers", () => {
    expect(parseThreshold("50000", 200_000)).toBe(50_000)
  })

  test("rejects invalid percentages", () => {
    expect(() => parseThreshold("0%", 200_000)).toThrow()
    expect(() => parseThreshold("101%", 200_000)).toThrow()
    expect(() => parseThreshold("-10%", 200_000)).toThrow()
    expect(() => parseThreshold("abc%", 200_000)).toThrow()
  })

  test("rejects invalid formats", () => {
    expect(() => parseThreshold("invalid", 200_000)).toThrow()
    expect(() => parseThreshold("100G", 200_000)).toThrow()
    expect(() => parseThreshold("", 200_000)).toThrow()
  })
})

describe("resolveThresholds", () => {
  test("parses and sorts percentages", () => {
    expect(resolveThresholds(["60%", "40%", "80%"], 200_000)).toEqual([80_000, 120_000, 160_000])
  })

  test("parses and sorts absolute values", () => {
    expect(resolveThresholds(["200K", "100K", "150K"], 500_000)).toEqual([100_000, 150_000, 200_000])
  })

  test("allows mixed percentage and absolute", () => {
    // window=200K, so 50%=100K, 25%=50K. Duplicate 100K is deduplicated.
    expect(resolveThresholds(["100K", "50%", "25%"], 200_000)).toEqual([50_000, 100_000])
  })

  test("deduplicates identical values after parsing", () => {
    // 50% of 200K = 100K, same as "100K"
    expect(resolveThresholds(["50%", "100K"], 200_000)).toEqual([100_000])
  })

  test("clamps a single over-cap threshold to maxAllowed instead of throwing", () => {
    // window=200K, default reserved=13K → maxAllowed=187K. "190K" exceeds; should clamp to 187K.
    expect(resolveThresholds(["190K"], 200_000)).toEqual([187_000])
  })

  test("clamps with explicit reserved override", () => {
    // window=200K, reserved=5K → maxAllowed=195K. "200K" exceeds; clamps to 195K.
    expect(resolveThresholds(["200K"], 200_000, 5_000)).toEqual([195_000])
  })

  test("clamps the first over-cap entry and drops subsequent over-cap entries", () => {
    // window=200K, default reserved=13K → maxAllowed=187K. ["60K", "190K", "195K"] →
    //   60K kept; 190K clamped to 187K (first over-cap); 195K dropped.
    expect(resolveThresholds(["60K", "190K", "195K"], 200_000)).toEqual([60_000, 187_000])
  })

  test("when ALL thresholds exceed cap, result is a single clamped entry", () => {
    // ["190K", "195K", "300K"] all > 187K → clamp first (190→187), drop rest.
    expect(resolveThresholds(["190K", "195K", "300K"], 200_000)).toEqual([187_000])
  })

  test("clamp respects user-provided order, not sorted order", () => {
    // ["300K", "190K"]: 300K is the first over-cap → clamps to 187K. 190K is also over-cap → dropped.
    // (Even though 190K is smaller, it doesn't beat 300K because 300K came first.)
    expect(resolveThresholds(["300K", "190K"], 200_000)).toEqual([187_000])
  })

  test("dedupe collapses sub-cap input that happens to equal the clamped value", () => {
    // window=200K, reserved=5K → maxAllowed=195K. ["195K", "200K"]:
    //   195K kept (= maxAllowed, allowed); 200K clamped to 195K. After sort+dedupe → [195K].
    expect(resolveThresholds(["195K", "200K"], 200_000, 5_000)).toEqual([195_000])
  })

  test("allows threshold exactly equal to maxAllowed (window - reserved)", () => {
    // window=200K, default reserved=13K → maxAllowed=187K. "187K" is exactly at the cap, allowed.
    expect(resolveThresholds(["187K"], 200_000)).toEqual([187_000])
  })

  test("throws when window is too small", () => {
    expect(() => resolveThresholds(["1K"], 10_000)).toThrow(/too small/)
  })

  test("returns empty array for empty input", () => {
    expect(resolveThresholds([], 200_000)).toEqual([])
  })

  test("defaults (40%, 60%, 80%) work on common window sizes", () => {
    expect(resolveThresholds(["40%", "60%", "80%"], 200_000)).toEqual([80_000, 120_000, 160_000])
    expect(resolveThresholds(["40%", "60%", "80%"], 1_000_000)).toEqual([400_000, 600_000, 800_000])
  })

  test("v7 defaults (30%, 60%, 90%) on 200K context produce [60K, 120K, 180K] (F5)", () => {
    expect(resolveThresholds(["30%", "60%", "90%"], 200_000)).toEqual([60_000, 120_000, 180_000])
  })

  test("default reserved is 13K", () => {
    // No `reserved` arg → CHECKPOINT_RESERVED kicks in. windowSize=200K, default reserved=13K → maxAllowed=187K.
    // 187K is allowed (= maxAllowed); 188K would be over.
    expect(resolveThresholds(["187K"], 200_000)).toEqual([187_000])
  })
})
