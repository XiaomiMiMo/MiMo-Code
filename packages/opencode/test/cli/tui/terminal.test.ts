import { describe, expect, test } from "bun:test"
import { isGNUScreenTerminal, isPlainTerminal } from "../../../src/cli/cmd/tui/util/terminal"

describe("tui terminal compatibility", () => {
  test("treats GNU screen terminals as plain terminals", () => {
    expect(isGNUScreenTerminal({ term: "screen" })).toBe(true)
    expect(isGNUScreenTerminal({ term: "screen-256color" })).toBe(true)
    expect(isPlainTerminal({ term: "screen", platform: "linux" })).toBe(true)
    expect(isPlainTerminal({ term: "screen-256color", platform: "linux" })).toBe(true)
  })

  test("treats GNU screen sessions as plain terminals even when TERM is generic", () => {
    expect(isGNUScreenTerminal({ term: "xterm-256color", sty: "1234.pts-0.host" })).toBe(true)
    expect(isPlainTerminal({ term: "xterm-256color", sty: "1234.pts-0.host", platform: "linux" })).toBe(true)
  })

  test("respects explicit plain terminal overrides", () => {
    expect(isPlainTerminal({ term: "screen", platform: "linux", plain: "false" })).toBe(false)
    expect(isPlainTerminal({ term: "xterm-256color", platform: "linux", plain: "true" })).toBe(true)
  })

  test("keeps regular xterm terminals out of plain mode by default", () => {
    expect(isPlainTerminal({ term: "xterm-256color", platform: "linux" })).toBe(false)
  })
})
