import { describe, test, expect } from "bun:test"
import { LoopDetector, type LoopCheck } from "../../src/session/loop-detector"

function feed(detector: LoopDetector, text: string, chunkSize = 64): LoopCheck {
  for (let i = 0; i < text.length; i += chunkSize) {
    const res = detector.append(text.slice(i, i + chunkSize))
    if (res.loop) return res
  }
  return { loop: false }
}

describe("LoopDetector", () => {
  test("does not flag normal prose", () => {
    const detector = new LoopDetector()
    const res = feed(
      detector,
      "Hello world! This is a test of the loop detector. It should not trigger for normal English sentences, even if there are some repeated words like test or loop or detector. ".repeat(
        3,
      ),
    )
    // Whole-paragraph repetition (~170 chars) needs 8 occurrences; 3 is fine.
    expect(res.loop).toBe(false)
  })

  test("detects a long sentence repeating", () => {
    const detector = new LoopDetector()
    const pattern = "We should explore the project directory and verify all generated codes. "
    expect(feed(detector, pattern.repeat(6)).loop).toBe(false)

    const res = feed(detector, pattern.repeat(6))
    expect(res.loop).toBe(true)
    if (res.loop) expect(res.period).toBe(pattern.length)
  })

  test("does not flag a sentence repeated a few times", () => {
    const detector = new LoopDetector()
    const pattern = "We should explore the project directory and verify all generated codes. "
    const res = feed(detector, pattern.repeat(5) + "Now let us move on to something completely different and unrelated here.")
    expect(res.loop).toBe(false)
  })

  test("detects regardless of chunk boundaries", () => {
    const detector = new LoopDetector()
    const res = feed(detector, "All work and no play makes Jack a dull boy. ".repeat(40), 7)
    expect(res.loop).toBe(true)
    if (res.loop) expect(res.period).toBe("All work and no play makes Jack a dull boy. ".length)
  })

  test("allows markdown dividers but flags extreme single-character runs", () => {
    const detector = new LoopDetector()
    expect(feed(detector, "-".repeat(280)).loop).toBe(false)

    const res = feed(detector, "-".repeat(300))
    expect(res.loop).toBe(true)
    if (res.loop) expect(res.period).toBe(1)
  })

  test("detects short word loops", () => {
    const detector = new LoopDetector()
    // period 6, needs 40 repetitions
    const res = feed(detector, "again ".repeat(60))
    expect(res.loop).toBe(true)
    if (res.loop) expect(res.period).toBe(6)
  })

  test("detects loops in unicode text", () => {
    const detector = new LoopDetector()
    // 「我们再试一次。」 period 7, needs 40 repetitions
    const res = feed(detector, "我们再试一次。".repeat(100))
    expect(res.loop).toBe(true)
    if (res.loop) expect(res.period).toBe(7)
  })

  test("tolerates repetitive data inside code fences", () => {
    const detector = new LoopDetector()
    const res = feed(detector, "```json\n" + "  0,\n".repeat(100))
    expect(res.loop).toBe(false)
  })

  test("flags the same repetitive data outside code fences", () => {
    const detector = new LoopDetector()
    const res = feed(detector, "  0,\n".repeat(100))
    expect(res.loop).toBe(true)
    if (res.loop) expect(res.period).toBe(5)
  })

  test("still detects long-line loops inside code fences", () => {
    const detector = new LoopDetector()
    const line = "console.log('attempting the operation once more now')\n"
    const res = feed(detector, "```ts\n" + line.repeat(30))
    expect(res.loop).toBe(true)
    if (res.loop) expect(res.period).toBe(line.length)
  })

  test("closed code fences restore normal thresholds", () => {
    const detector = new LoopDetector()
    expect(feed(detector, "```json\n[1, 2]\n```\nDone. ").loop).toBe(false)
    const res = feed(detector, "  0,\n".repeat(100))
    expect(res.loop).toBe(true)
  })

  test("counts fence markers split across chunks", () => {
    const detector = new LoopDetector()
    detector.append("`")
    detector.append("``json\n")
    const res = feed(detector, "  0,\n".repeat(100))
    expect(res.loop).toBe(false)
  })

  test("reset clears accumulated state", () => {
    const detector = new LoopDetector()
    const pattern = "We should explore the project directory and verify all generated codes. "
    expect(feed(detector, pattern.repeat(7)).loop).toBe(false)
    detector.reset()
    expect(feed(detector, pattern.repeat(7)).loop).toBe(false)
  })

  test("handles empty strings", () => {
    const detector = new LoopDetector()
    expect(detector.append("").loop).toBe(false)
  })

  test("detects a loop that starts after a long normal stream", () => {
    const detector = new LoopDetector()
    let prose = ""
    for (let i = 0; i < 5000; i++) prose += `word${i.toString(36)} `
    expect(feed(detector, prose).loop).toBe(false)

    const res = feed(detector, "I will try the same approach once more. ".repeat(20))
    expect(res.loop).toBe(true)
  })

  test("processes 1MB of non-repeating text quickly", () => {
    const detector = new LoopDetector()
    let text = ""
    for (let i = 0; text.length < 1_000_000; i++) text += `token${i.toString(36)} `
    const start = performance.now()
    const res = feed(detector, text)
    const elapsed = performance.now() - start
    expect(res.loop).toBe(false)
    // The previous suffix-automaton implementation was quadratic and froze the
    // event loop on input like this; the windowed scan stays in milliseconds.
    expect(elapsed).toBeLessThan(2000)
  })

  test("processes heavily looping text quickly", () => {
    const detector = new LoopDetector()
    const start = performance.now()
    const res = feed(detector, "All work and no play makes Jack a dull boy. ".repeat(25_000))
    const elapsed = performance.now() - start
    expect(res.loop).toBe(true)
    expect(elapsed).toBeLessThan(2000)
  })
})
