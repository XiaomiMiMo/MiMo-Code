import { describe, expect, test } from "bun:test"
import {
  TextNgramMonitor,
  detectConsecutiveRepeat,
  detectRepeatedNgram,
  tokenizeForNgram,
} from "../../src/session/prompt/text-ngram-detection"

describe("tokenizeForNgram", () => {
  test("normalizes whitespace and case", () => {
    expect(tokenizeForNgram("  Hello   WORLD  ")).toEqual(["hello", "world"])
  })

  test("splits CJK characters individually", () => {
    expect(tokenizeForNgram("你好世界")).toEqual(["你", "好", "世", "界"])
  })

  test("handles mixed CJK and English", () => {
    expect(tokenizeForNgram("hello 你好 world")).toEqual(["hello", "你", "好", "world"])
  })
})

describe("detectRepeatedNgram (legacy)", () => {
  test("returns false when window is too small", () => {
    expect(detectRepeatedNgram(["a", "b", "c"], 6, 3)).toBe(false)
  })

  test("detects repeated 6-gram appearing 3 times", () => {
    const gram = ["one", "two", "three", "four", "five", "six"]
    const tokens = [...gram, ...gram, ...gram]
    expect(detectRepeatedNgram(tokens, 6, 3)).toBe(true)
  })

  test("returns false when same phrase appears only twice", () => {
    const gram = ["one", "two", "three", "four", "five", "six"]
    const tokens = [...gram, ...gram]
    expect(detectRepeatedNgram(tokens, 6, 3)).toBe(false)
  })
})

describe("detectConsecutiveRepeat", () => {
  test("returns false when tokens are too few", () => {
    expect(detectConsecutiveRepeat(["a", "b", "c"], 4, 20)).toBe(false)
  })

  test("detects block repeated 20 times consecutively", () => {
    const block = ["one", "two", "three", "four", "five", "six"]
    const tokens: string[] = []
    for (let i = 0; i < 20; i++) tokens.push(...block)
    expect(detectConsecutiveRepeat(tokens, 4, 20)).toBe(true)
  })

  test("returns false when same block appears only 19 times", () => {
    const block = ["one", "two", "three", "four", "five", "six"]
    const tokens: string[] = []
    for (let i = 0; i < 19; i++) tokens.push(...block)
    expect(detectConsecutiveRepeat(tokens, 4, 20)).toBe(false)
  })

  test("returns false for markdown table with repeated column values", () => {
    const table = `| field1 | string | required | - |
| field2 | string | required | - |
| field3 | string | required | - |
| field4 | string | required | - |
| field5 | string | required | - |
| field6 | string | required | - |
| field7 | string | required | - |
| field8 | string | required | - |`
    const tokens = tokenizeForNgram(table)
    expect(detectConsecutiveRepeat(tokens, 4, 20)).toBe(false)
  })

  test("returns false for Yes/No feature comparison table", () => {
    const table = `| feature1 | Yes | No | Yes |
| feature2 | Yes | No | Yes |
| feature3 | Yes | No | Yes |
| feature4 | Yes | No | Yes |
| feature5 | Yes | No | Yes |
| feature6 | Yes | No | Yes |
| feature7 | Yes | No | Yes |
| feature8 | Yes | No | Yes |`
    const tokens = tokenizeForNgram(table)
    expect(detectConsecutiveRepeat(tokens, 4, 20)).toBe(false)
  })

  test("returns false for low-distinct repetition (single token repeated)", () => {
    const tokens = Array(200).fill("1")
    expect(detectConsecutiveRepeat(tokens, 4, 20)).toBe(false)
  })

  test("returns false for low-distinct repetition (two tokens alternating)", () => {
    const tokens: string[] = []
    for (let i = 0; i < 100; i++) tokens.push("|", "---")
    expect(detectConsecutiveRepeat(tokens, 4, 20)).toBe(false)
  })

  test("detects CJK repetition: same phrase repeated 20 times", () => {
    // "你好我的用户" repeated 20 times
    const text = "你好我的用户".repeat(20)
    const tokens = tokenizeForNgram(text)
    expect(detectConsecutiveRepeat(tokens, 4, 20)).toBe(true)
  })

  test("does not trigger CJK with only 10 repetitions", () => {
    const text = "你好我的用户".repeat(10)
    const tokens = tokenizeForNgram(text)
    expect(detectConsecutiveRepeat(tokens, 4, 20)).toBe(false)
  })

  test("detects real English loop repeated 20 times", () => {
    const sentence = "let me try again "
    const tokens = tokenizeForNgram(sentence.repeat(20))
    expect(detectConsecutiveRepeat(tokens, 4, 20)).toBe(true)
  })

  test("returns false for non-consecutive repetition with varying content between", () => {
    const tokens = tokenizeForNgram(
      "I am the wind that blows through the valley at dawn, I am the flower that blooms in the garden of spring, I am the moon that shines over the mountains at night, I am the sun that rises above the endless horizon",
    )
    expect(detectConsecutiveRepeat(tokens, 4, 20)).toBe(false)
  })
})

describe("TextNgramMonitor", () => {
  test("detects repetition across incremental appends", () => {
    const monitor = new TextNgramMonitor(4, 20, 500)
    const chunk = "one two three four five six "
    for (let i = 0; i < 19; i++) {
      expect(monitor.append(chunk)).toBe(false)
    }
    expect(monitor.append(chunk)).toBe(true)
  })

  test("reset clears prior repetition state", () => {
    const monitor = new TextNgramMonitor(4, 20, 500)
    const chunk = "one two three four five six "
    for (let i = 0; i < 20; i++) monitor.append(chunk)
    monitor.reset()
    expect(monitor.append(chunk)).toBe(false)
  })

  test("does not trigger on markdown tables", () => {
    const monitor = new TextNgramMonitor(4, 20, 500)
    const table = `| name | string | required | The name of the user |
| email | string | required | The email of the user |
| phone | string | required | The phone of the user |
| address | string | required | The address of the user |
| city | string | required | The city of the user |
| country | string | required | The country of the user |
| zipcode | string | required | The zipcode of the user |
| state | string | required | The state of the user |`
    expect(monitor.append(table)).toBe(false)
  })

  test("does not trigger on single-token repetition", () => {
    const monitor = new TextNgramMonitor(4, 20, 500)
    expect(monitor.append(Array(200).fill("1").join(" "))).toBe(false)
  })

  test("detects CJK model loop", () => {
    const monitor = new TextNgramMonitor(4, 20, 500)
    expect(monitor.append("你好我的用户".repeat(20))).toBe(true)
  })

  test("detects English model loop", () => {
    const monitor = new TextNgramMonitor(4, 20, 500)
    expect(monitor.append("I will fix this bug ".repeat(20))).toBe(true)
  })
})
