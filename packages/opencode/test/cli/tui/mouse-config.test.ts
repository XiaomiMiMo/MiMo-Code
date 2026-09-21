import { describe, expect, test } from "bun:test"
import { isMouseEnabled } from "../../../src/cli/cmd/tui/util/mouse"

describe("isMouseEnabled", () => {
  test("disables mouse capture by default on Windows terminals", () => {
    expect(isMouseEnabled({}, { platform: "win32", plainTerminal: false, disabled: false })).toBe(false)
  })

  test("allows explicit Windows mouse opt-in", () => {
    expect(isMouseEnabled({ mouse: true }, { platform: "win32", plainTerminal: false, disabled: false })).toBe(true)
  })

  test("keeps mouse capture enabled by default outside Windows", () => {
    expect(isMouseEnabled({}, { platform: "linux", plainTerminal: false, disabled: false })).toBe(true)
  })

  test("honors plain terminal and disable flag before config opt-in", () => {
    expect(isMouseEnabled({ mouse: true }, { platform: "linux", plainTerminal: true, disabled: false })).toBe(false)
    expect(isMouseEnabled({ mouse: true }, { platform: "linux", plainTerminal: false, disabled: true })).toBe(false)
  })
})
