import { describe, expect, test } from "bun:test"
import { mouseEnabledForRenderer } from "../../../../src/cli/cmd/tui/util/mouse"

describe("mouse renderer config", () => {
  test("disables mouse capture on Windows unless explicitly enabled", () => {
    expect(mouseEnabledForRenderer({}, { platform: "win32", plainTerminal: false, disableMouse: false })).toBe(false)
    expect(
      mouseEnabledForRenderer({ mouse: true }, { platform: "win32", plainTerminal: false, disableMouse: false }),
    ).toBe(true)
  })

  test("keeps existing opt out paths", () => {
    expect(mouseEnabledForRenderer({ mouse: true }, { platform: "linux", plainTerminal: true, disableMouse: false })).toBe(
      false,
    )
    expect(mouseEnabledForRenderer({ mouse: true }, { platform: "linux", plainTerminal: false, disableMouse: true })).toBe(
      false,
    )
    expect(mouseEnabledForRenderer({ mouse: false }, { platform: "linux", plainTerminal: false, disableMouse: false })).toBe(
      false,
    )
  })
})
