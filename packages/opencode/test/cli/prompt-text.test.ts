import { describe, expect, test } from "bun:test"
import { normalizePromptText } from "../../src/cli/prompt-text"

describe("normalizePromptText", () => {
  test("strips CRLF line endings", () => {
    expect(normalizePromptText("fix tests\r\n")).toBe("fix tests\n")
  })

  test("strips lone carriage returns", () => {
    expect(normalizePromptText("line1\rline2")).toBe("line1\nline2")
  })

  test("leaves unix newlines unchanged", () => {
    expect(normalizePromptText("fix tests\n")).toBe("fix tests\n")
  })
})
