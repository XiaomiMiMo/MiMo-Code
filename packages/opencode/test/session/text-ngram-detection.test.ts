import { describe, expect, test } from "bun:test"
import {
  TextNgramMonitor,
  detectRepeatedNgram,
  tokenizeForNgram,
} from "../../src/session/prompt/text-ngram-detection"

describe("tokenizeForNgram", () => {
  test("normalizes whitespace and case", () => {
    expect(tokenizeForNgram("  Hello   WORLD  ")).toEqual(["hello", "world"])
  })
})

describe("detectRepeatedNgram", () => {
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

describe("TextNgramMonitor", () => {
  test("detects repetition across incremental appends", () => {
    const monitor = new TextNgramMonitor(6, 3, 500)
    const chunk = "one two three four five six "
    expect(monitor.append(chunk)).toBe(false)
    expect(monitor.append(chunk)).toBe(false)
    expect(monitor.append(chunk)).toBe(true)
  })

  test("reset clears prior repetition state", () => {
    const monitor = new TextNgramMonitor(6, 3, 500)
    const chunk = "one two three four five six "
    monitor.append(chunk)
    monitor.append(chunk)
    monitor.append(chunk)
    monitor.reset()
    expect(monitor.append(chunk)).toBe(false)
  })

  test("respects sliding window token limit", () => {
    const monitor = new TextNgramMonitor(3, 3, 10)
    const filler = Array.from({ length: 10 }, (_, i) => `f${i}`).join(" ") + " "
    const repeated = "alpha beta gamma "
    expect(monitor.append(filler + repeated + repeated + repeated)).toBe(true)
    monitor.reset()
    monitor.append(filler)
    expect(monitor.append(repeated)).toBe(false)
    expect(monitor.append(repeated)).toBe(false)
    expect(monitor.append(repeated)).toBe(true)
  })

  test("ignores format-driven repetition in long markdown tables", () => {
    const monitor = new TextNgramMonitor(6, 3, 500)
    const table = [
      "| Technology | Current | After Integration | Verdict |",
      "| --- | --- | --- | --- |",
      "| Search | Current after integration verdict needs review | Uses indexed retrieval | Stable |",
      "| Storage | Current after integration verdict needs review | Uses durable cache | Stable |",
      "| Billing | Current after integration verdict needs review | Uses invoice sync | Stable |",
    ].join("\n")

    expect(monitor.append(table)).toBe(false)
  })

  test("ignores format-driven repetition in long markdown lists", () => {
    const monitor = new TextNgramMonitor(6, 3, 500)
    const list = [
      "  - Search: current after integration verdict needs review",
      "  - Storage: current after integration verdict needs review",
      "  - Billing: current after integration verdict needs review",
    ].join("\n")

    expect(monitor.append(list)).toBe(false)
  })

  test("does not treat pipe-bounded prose as a markdown table", () => {
    const monitor = new TextNgramMonitor(6, 3, 500)
    const repeated = "|x| the same failure keeps happening again now "

    expect(monitor.append(`${repeated}${repeated}${repeated}`)).toBe(true)
  })

  test("does not ignore pipe rows without a table separator", () => {
    const monitor = new TextNgramMonitor(6, 3, 500)
    const row = "| Not a table | the same failure keeps happening again now |"

    expect(monitor.append([row, row, row].join("\n"))).toBe(true)
  })

  test("still detects exact repeated structured rows", () => {
    const monitor = new TextNgramMonitor(6, 3, 500)
    const row = "| Repeat | the same failure keeps happening again now |"

    expect(monitor.append([row, row, row].join("\n"))).toBe(true)
  })

  test("still detects repeated prose around structured output", () => {
    const monitor = new TextNgramMonitor(6, 3, 500)
    const table = [
      "| Technology | Current | After Integration | Verdict |",
      "| --- | --- | --- | --- |",
      "| Search | Uses indexed retrieval | Stable |",
      "| Storage | Uses durable cache | Stable |",
      "| Billing | Uses invoice sync | Stable |",
    ].join("\n")
    const repeated = "the same failure keeps happening again now "

    expect(monitor.append(`${table}\n${repeated}${repeated}${repeated}`)).toBe(true)
  })
})
