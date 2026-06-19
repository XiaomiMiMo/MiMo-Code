import { describe, expect, test } from "bun:test"
import {
  TEXT_LOOP_BUFFER_SIZE,
  TEXT_LOOP_TRIGGER_COUNT,
  TEXT_LOOP_MAX_RECOVERY,
  normalizeForLoopDetection,
  detectTextLoop,
} from "../../src/session/prompt/text-loop-recovery"

describe("Text loop detection", () => {
  test("TEXT_LOOP_TRIGGER_COUNT is 3", () => {
    expect(TEXT_LOOP_TRIGGER_COUNT).toBe(3)
  })

  test("TEXT_LOOP_MAX_RECOVERY is 2", () => {
    expect(TEXT_LOOP_MAX_RECOVERY).toBe(2)
  })

  test("TEXT_LOOP_BUFFER_SIZE is 5", () => {
    expect(TEXT_LOOP_BUFFER_SIZE).toBe(5)
  })

  test("detectTextLoop returns true for 3 identical entries", () => {
    const buffer = ["hello world", "hello world", "hello world"]
    expect(detectTextLoop(buffer, 3)).toBe(true)
  })

  test("detectTextLoop returns false for 2 identical entries with trigger 3", () => {
    const buffer = ["hello world", "hello world"]
    expect(detectTextLoop(buffer, 3)).toBe(false)
  })

  test("detectTextLoop returns false for different entries", () => {
    const buffer = ["hello", "world", "hello"]
    expect(detectTextLoop(buffer, 3)).toBe(false)
  })
})

describe("normalizeForLoopDetection", () => {
  test("trims and lowercases", () => {
    expect(normalizeForLoopDetection("  Hello World  ")).toBe("hello world")
  })

  test("collapses whitespace", () => {
    expect(normalizeForLoopDetection("hello   world")).toBe("hello world")
  })

  test("removes common prefixes", () => {
    expect(normalizeForLoopDetection("let me check the file")).toBe("check the file")
    expect(normalizeForLoopDetection("I'll look into it")).toBe("look into it")
    expect(normalizeForLoopDetection("I will check")).toBe("check")
    expect(normalizeForLoopDetection("let's try this")).toBe("try this")
  })

  test("truncates at 300 characters", () => {
    const long = "a".repeat(400)
    expect(normalizeForLoopDetection(long)).toHaveLength(300)
  })
})
