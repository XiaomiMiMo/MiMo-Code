import { describe, expect, test } from "bun:test"
import {
  normalizeForLoopDetection,
  detectTextLoop,
  TEXT_LOOP_TRIGGER_COUNT,
  TEXT_LOOP_BUFFER_SIZE,
  TEXT_LOOP_MAX_RECOVERY,
} from "../../src/session/prompt/text-loop-recovery"

describe("normalizeForLoopDetection", () => {
  test("trims whitespace", () => {
    expect(normalizeForLoopDetection("  hello world  ")).toBe("hello world")
  })

  test("lowercases text", () => {
    expect(normalizeForLoopDetection("Hello World")).toBe("hello world")
  })

  test("collapses multiple whitespace", () => {
    expect(normalizeForLoopDetection("hello   \n\t  world")).toBe("hello world")
  })

  test("strips common filler prefixes", () => {
    expect(normalizeForLoopDetection("Let me check the file")).toBe("check the file")
    expect(normalizeForLoopDetection("I'll look into this")).toBe("look into this")
    expect(normalizeForLoopDetection("I will investigate")).toBe("investigate")
    expect(normalizeForLoopDetection("Let's do something")).toBe("do something")
  })

  test("truncates to 200 chars", () => {
    const long = "a".repeat(300)
    expect(normalizeForLoopDetection(long)).toHaveLength(200)
  })

  test("identical inputs produce identical outputs", () => {
    const a = normalizeForLoopDetection("  Let me check if one was already created  ")
    const b = normalizeForLoopDetection("Let me check if one was already created")
    expect(a).toBe(b)
  })

  test("different inputs produce different outputs", () => {
    const a = normalizeForLoopDetection("Let me check the changelog")
    const b = normalizeForLoopDetection("I will try a different approach")
    expect(a).not.toBe(b)
  })
})

describe("detectTextLoop", () => {
  test("returns false when buffer too small", () => {
    expect(detectTextLoop(["a", "a"], 3)).toBe(false)
  })

  test("returns false when last N entries differ", () => {
    expect(detectTextLoop(["a", "b", "c"], 3)).toBe(false)
    expect(detectTextLoop(["a", "a", "b"], 3)).toBe(false)
  })

  test("returns true when last N entries are identical", () => {
    expect(detectTextLoop(["a", "a", "a"], 3)).toBe(true)
    expect(detectTextLoop(["x", "a", "a", "a"], 3)).toBe(true)
  })

  test("only checks the tail, not earlier entries", () => {
    expect(detectTextLoop(["b", "c", "a", "a", "a"], 3)).toBe(true)
    expect(detectTextLoop(["a", "a", "b", "b", "b"], 3)).toBe(true)
  })

  test("works with threshold of 2", () => {
    expect(detectTextLoop(["a", "a"], 2)).toBe(true)
    expect(detectTextLoop(["a", "b"], 2)).toBe(false)
  })
})

describe("text loop detection integration logic", () => {
  test("full detection flow: 3 identical triggers detection", () => {
    const buffer: string[] = []
    const texts = [
      "Let me check if one was already created earlier and update it.",
      "Let me check if one was already created earlier and update it.",
      "Let me check if one was already created earlier and update it.",
    ]

    let triggered = false
    for (const text of texts) {
      const normalized = normalizeForLoopDetection(text)
      buffer.push(normalized)
      if (buffer.length > TEXT_LOOP_BUFFER_SIZE) buffer.shift()

      if (buffer.length >= TEXT_LOOP_TRIGGER_COUNT) {
        if (detectTextLoop(buffer, TEXT_LOOP_TRIGGER_COUNT)) {
          triggered = true
          break
        }
      }
    }

    expect(triggered).toBe(true)
  })

  test("mixed texts do not trigger", () => {
    const buffer: string[] = []
    const texts = [
      "Let me check the file",
      "I found the changelog",
      "Let me update it now",
    ]

    let triggered = false
    for (const text of texts) {
      const normalized = normalizeForLoopDetection(text)
      buffer.push(normalized)
      if (buffer.length > TEXT_LOOP_BUFFER_SIZE) buffer.shift()

      if (buffer.length >= TEXT_LOOP_TRIGGER_COUNT) {
        if (detectTextLoop(buffer, TEXT_LOOP_TRIGGER_COUNT)) {
          triggered = true
        }
      }
    }

    expect(triggered).toBe(false)
  })

  test("clearing the buffer resets the detection window", () => {
    const buffer: string[] = []
    const repeatedText = "The user wants me to create a ChangeLog file."

    for (let i = 0; i < 3; i++) {
      buffer.push(normalizeForLoopDetection(repeatedText))
    }
    expect(detectTextLoop(buffer, TEXT_LOOP_TRIGGER_COUNT)).toBe(true)
    buffer.length = 0

    buffer.push(normalizeForLoopDetection(repeatedText))
    expect(detectTextLoop(buffer, TEXT_LOOP_TRIGGER_COUNT)).toBe(false)
  })

  test("different outputs do not trigger after a buffer reset", () => {
    const buffer: string[] = []
    const repeatedText = "I am stuck in a loop"
    const differentText = "OK I will try something else"

    // 3 identical → trigger
    for (let i = 0; i < 3; i++) {
      buffer.push(normalizeForLoopDetection(repeatedText))
    }
    expect(detectTextLoop(buffer, TEXT_LOOP_TRIGGER_COUNT)).toBe(true)
    buffer.length = 0

    buffer.push(normalizeForLoopDetection(differentText))
    buffer.push(normalizeForLoopDetection("Now doing something useful"))
    buffer.push(normalizeForLoopDetection("Almost done"))
    expect(detectTextLoop(buffer, TEXT_LOOP_TRIGGER_COUNT)).toBe(false)
  })

  test("constants have expected values", () => {
    expect(TEXT_LOOP_BUFFER_SIZE).toBe(5)
    expect(TEXT_LOOP_TRIGGER_COUNT).toBe(3)
    expect(TEXT_LOOP_MAX_RECOVERY).toBe(0)
  })
})
