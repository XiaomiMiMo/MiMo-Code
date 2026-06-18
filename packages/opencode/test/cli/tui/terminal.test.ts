import { expect, test, describe } from "bun:test"

const { needsTextSizingDisabled, isMacNativeTerminal, isPlainTerminal } = await import(
  "../../../src/cli/cmd/tui/util/terminal"
)

describe("needsTextSizingDisabled", () => {
  test("returns true for VTE terminals (VTE_VERSION set)", () => {
    // MATE Terminal / GNOME Terminal export a numeric VTE_VERSION like "6800".
    expect(needsTextSizingDisabled({ vteVersion: "6800" })).toBe(true)
  })

  test("returns false on a non-VTE terminal with no override", () => {
    expect(needsTextSizingDisabled({})).toBe(false)
  })

  test("treats an empty VTE_VERSION as not-a-VTE", () => {
    expect(needsTextSizingDisabled({ vteVersion: "" })).toBe(false)
  })

  test("MIMOCODE_DISABLE_TEXT_SIZING=1/true forces the workaround on any terminal", () => {
    expect(needsTextSizingDisabled({ disableTextSizing: "1" })).toBe(true)
    expect(needsTextSizingDisabled({ disableTextSizing: "true" })).toBe(true)
  })

  test("MIMOCODE_DISABLE_TEXT_SIZING=0/false overrides VTE auto-detection", () => {
    // Explicit opt-out must win even when VTE_VERSION is present.
    expect(needsTextSizingDisabled({ vteVersion: "6800", disableTextSizing: "0" })).toBe(false)
    expect(needsTextSizingDisabled({ vteVersion: "6800", disableTextSizing: "false" })).toBe(false)
  })

  test("an unrecognized MIMOCODE_DISABLE_TEXT_SIZING value falls back to VTE auto-detection", () => {
    expect(needsTextSizingDisabled({ vteVersion: "6800", disableTextSizing: "maybe" })).toBe(true)
    expect(needsTextSizingDisabled({ disableTextSizing: "maybe" })).toBe(false)
  })
})

describe("isMacNativeTerminal", () => {
  test("true only for Apple_Terminal on darwin", () => {
    expect(isMacNativeTerminal({ platform: "darwin", termProgram: "Apple_Terminal" })).toBe(true)
    expect(isMacNativeTerminal({ platform: "darwin", termProgram: "iTerm.app" })).toBe(false)
    expect(isMacNativeTerminal({ platform: "linux", termProgram: "Apple_Terminal" })).toBe(false)
  })
})

describe("isPlainTerminal", () => {
  test("MIMOCODE_TUI_PLAIN overrides terminal heuristics", () => {
    expect(isPlainTerminal({ plain: "1" })).toBe(true)
    expect(isPlainTerminal({ plain: "true" })).toBe(true)
    expect(isPlainTerminal({ plain: "0", platform: "darwin", termProgram: "Apple_Terminal" })).toBe(false)
    expect(isPlainTerminal({ plain: "false", platform: "darwin", termProgram: "Apple_Terminal" })).toBe(false)
  })

  test("defaults to mac-native detection when MIMOCODE_TUI_PLAIN is unset", () => {
    expect(isPlainTerminal({ platform: "darwin", termProgram: "Apple_Terminal" })).toBe(true)
    expect(isPlainTerminal({ platform: "linux", termProgram: "xterm" })).toBe(false)
  })
})
