import { describe, expect, test } from "bun:test"
import { EOL } from "os"
import { UI } from "../../src/cli/ui"

describe("cli.ui", () => {
  test("adds one trailing EOL when output is missing one", () => {
    expect(UI.withTrailingEOL("help")).toBe("help" + EOL)
  })

  test("does not duplicate an existing trailing EOL", () => {
    expect(UI.withTrailingEOL("help" + EOL)).toBe("help" + EOL)
  })

  test("normalizes multiple and mixed trailing line endings", () => {
    expect(UI.withTrailingEOL("help\n\r\n\n")).toBe("help" + EOL)
  })

  test("returns one EOL for empty output", () => {
    expect(UI.withTrailingEOL("")).toBe(EOL)
  })
})
