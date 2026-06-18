import { describe, expect, test } from "bun:test"
import { isMouseEnabled, isPlainTerminal } from "../../../src/cli/cmd/tui/util/terminal"

describe("tui terminal detection", () => {
  test("treats Apple Terminal as plain by default", () => {
    expect(isPlainTerminal({ platform: "darwin", termProgram: "Apple_Terminal" })).toBe(true)
  })

  test("keeps mouse enabled in plain terminals unless explicitly disabled", () => {
    expect(isMouseEnabled({ plainTerminal: true })).toBe(true)
    expect(isMouseEnabled({ plainTerminal: true, configMouse: false })).toBe(false)
    expect(isMouseEnabled({ plainTerminal: true, disableMouse: true })).toBe(false)
  })
})
