import { describe, expect, test } from "bun:test"
import { isolateBidiText } from "../../../src/cli/cmd/tui/util/bidi"

describe("isolateBidiText", () => {
  test("wraps RTL display text in isolate controls", () => {
    expect(isolateBidiText("سلام دنیا!")).toBe("\u2067سلام دنیا!\u2069")
  })

  test("keeps fenced code blocks unchanged", () => {
    const input = ["قبل", "```ts", "const label = \"سلام\"", "```", "بعد"].join("\n")

    expect(isolateBidiText(input)).toBe(["\u2067قبل\u2069", "```ts", "const label = \"سلام\"", "```", "\u2067بعد\u2069"].join("\n"))
  })

  test("does not double-wrap text that already has bidi controls", () => {
    expect(isolateBidiText("\u2067سلام\u2069")).toBe("\u2067سلام\u2069")
  })
})
