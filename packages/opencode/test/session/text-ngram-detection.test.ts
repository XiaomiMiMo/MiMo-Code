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
    expect(detectConsecutiveRepeat(["a", "b", "c"], 20, 3)).toBe(false)
  })

  test("detects 20-token block repeated 3 times consecutively", () => {
    const block = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ")
    const tokens = [...block, ...block, ...block]
    expect(detectConsecutiveRepeat(tokens, 20, 3)).toBe(true)
  })

  test("detects longer block repeated consecutively", () => {
    const block = "the model is stuck in a loop and keeps repeating itself over and over again without making any progress on the task".split(" ")
    const tokens = [...block, ...block, ...block]
    expect(detectConsecutiveRepeat(tokens, 20, 3)).toBe(true)
  })

  test("returns false when same block appears only twice", () => {
    const block = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ")
    const tokens = [...block, ...block]
    expect(detectConsecutiveRepeat(tokens, 20, 3)).toBe(false)
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
    expect(detectConsecutiveRepeat(tokens, 20, 3)).toBe(false)
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
    expect(detectConsecutiveRepeat(tokens, 20, 3)).toBe(false)
  })

  test("returns false for API docs table with repeated descriptions", () => {
    const table = `| userId | string | The unique identifier for the user |
| teamId | string | The unique identifier for the team |
| orgId | string | The unique identifier for the org |
| roleId | string | The unique identifier for the role |
| groupId | string | The unique identifier for the group |
| tokenId | string | The unique identifier for the token |
| sessionId | string | The unique identifier for the session |
| accountId | string | The unique identifier for the account |`
    const tokens = tokenizeForNgram(table)
    expect(detectConsecutiveRepeat(tokens, 20, 3)).toBe(false)
  })

  test("returns false for low-distinct repetition (single token repeated)", () => {
    // e.g. "1 1 1 1 1 ..." — only 1 distinct token
    const tokens = Array(60).fill("1")
    expect(detectConsecutiveRepeat(tokens, 20, 3)).toBe(false)
  })

  test("returns false for low-distinct repetition (two tokens alternating)", () => {
    // e.g. "| --- | --- | --- ..." — only 2 distinct tokens
    const tokens: string[] = []
    for (let i = 0; i < 30; i++) tokens.push("|", "---")
    expect(detectConsecutiveRepeat(tokens, 20, 3)).toBe(false)
  })

  test("detects real loop: same sentence repeated back-to-back", () => {
    const sentence = "let me try a different approach to fix this issue in the codebase right now and see what happens with the new changes "
    const tokens = tokenizeForNgram(sentence + sentence + sentence)
    expect(detectConsecutiveRepeat(tokens, 20, 3)).toBe(true)
  })

  test("returns false for non-consecutive repetition with varying content between", () => {
    const tokens = tokenizeForNgram(
      "I am the wind that blows through the valley at dawn, I am the flower that blooms in the garden of spring, I am the moon that shines over the mountains at night, I am the sun that rises above the endless horizon",
    )
    expect(detectConsecutiveRepeat(tokens, 20, 3)).toBe(false)
  })
})

describe("TextNgramMonitor", () => {
  test("detects repetition across incremental appends", () => {
    const monitor = new TextNgramMonitor(20, 3, 500)
    const chunk = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty "
    expect(monitor.append(chunk)).toBe(false)
    expect(monitor.append(chunk)).toBe(false)
    expect(monitor.append(chunk)).toBe(true)
  })

  test("reset clears prior repetition state", () => {
    const monitor = new TextNgramMonitor(20, 3, 500)
    const chunk = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty "
    monitor.append(chunk)
    monitor.append(chunk)
    monitor.append(chunk)
    monitor.reset()
    expect(monitor.append(chunk)).toBe(false)
  })

  test("does not trigger on markdown tables", () => {
    const monitor = new TextNgramMonitor(20, 3, 500)
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
    const monitor = new TextNgramMonitor(20, 3, 500)
    expect(monitor.append(Array(100).fill("1").join(" "))).toBe(false)
  })

  test("triggers on real model loop", () => {
    const monitor = new TextNgramMonitor(20, 3, 500)
    const stuck = "I will help you fix this bug in the codebase by checking the implementation and running all the tests to verify correctness "
    expect(monitor.append(stuck + stuck + stuck)).toBe(true)
  })
})
