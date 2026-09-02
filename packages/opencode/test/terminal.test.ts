import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  isMacNativeTerminal,
  isPlainTerminal,
  isWindowsTerminal,
  needsTextSizingDisabled,
} from "../src/cli/cmd/tui/util/terminal"

describe("isWindowsTerminal", () => {
  const originalWTSession = process.env.WT_SESSION
  const originalVTEVersion = process.env.VTE_VERSION
  const originalDisableTextSizing = process.env.MIMOCODE_DISABLE_TEXT_SIZING
  const originalTuiPlain = process.env.MIMOCODE_TUI_PLAIN

  beforeEach(() => {
    delete process.env.WT_SESSION
    delete process.env.VTE_VERSION
    delete process.env.MIMOCODE_DISABLE_TEXT_SIZING
    delete process.env.MIMOCODE_TUI_PLAIN
  })

  afterEach(() => {
    if (originalWTSession !== undefined) {
      process.env.WT_SESSION = originalWTSession
    } else {
      delete process.env.WT_SESSION
    }
    if (originalVTEVersion !== undefined) {
      process.env.VTE_VERSION = originalVTEVersion
    } else {
      delete process.env.VTE_VERSION
    }
    if (originalDisableTextSizing !== undefined) {
      process.env.MIMOCODE_DISABLE_TEXT_SIZING = originalDisableTextSizing
    } else {
      delete process.env.MIMOCODE_DISABLE_TEXT_SIZING
    }
    if (originalTuiPlain !== undefined) {
      process.env.MIMOCODE_TUI_PLAIN = originalTuiPlain
    } else {
      delete process.env.MIMOCODE_TUI_PLAIN
    }
  })

  test("returns true when wtSession input is set", () => {
    expect(isWindowsTerminal({ wtSession: "some-guid" })).toBe(true)
  })

  test("returns true when wtSession input is empty string", () => {
    expect(isWindowsTerminal({ wtSession: "" })).toBe(false)
  })

  test("returns false when wtSession input is undefined", () => {
    expect(isWindowsTerminal({ wtSession: undefined })).toBe(false)
  })

  test("returns true when WT_SESSION env var is set", () => {
    process.env.WT_SESSION = "abc-123-guid"
    expect(isWindowsTerminal()).toBe(true)
  })

  test("returns false when WT_SESSION env var is not set", () => {
    expect(isWindowsTerminal()).toBe(false)
  })

  test("input wtSession takes precedence over env var", () => {
    process.env.WT_SESSION = "env-guid"
    expect(isWindowsTerminal({ wtSession: "input-guid" })).toBe(true)
  })

  test("returns false when input is undefined and no env var", () => {
    expect(isWindowsTerminal()).toBe(false)
  })
})

describe("needsTextSizingDisabled", () => {
  test("returns true for VTE terminals", () => {
    expect(needsTextSizingDisabled({ vteVersion: "6800" })).toBe(true)
  })

  test("returns false on a non-VTE terminal with no override", () => {
    expect(needsTextSizingDisabled({})).toBe(false)
  })

  test("treats empty VTE_VERSION as not VTE", () => {
    expect(needsTextSizingDisabled({ vteVersion: "" })).toBe(false)
  })

  test("MIMOCODE_DISABLE_TEXT_SIZING=1/true forces the workaround", () => {
    expect(needsTextSizingDisabled({ disableTextSizing: "1" })).toBe(true)
    expect(needsTextSizingDisabled({ disableTextSizing: "true" })).toBe(true)
  })

  test("MIMOCODE_DISABLE_TEXT_SIZING=0/false overrides VTE auto-detection", () => {
    expect(needsTextSizingDisabled({ vteVersion: "6800", disableTextSizing: "0" })).toBe(false)
    expect(needsTextSizingDisabled({ vteVersion: "6800", disableTextSizing: "false" })).toBe(false)
  })

  test("unrecognized MIMOCODE_DISABLE_TEXT_SIZING falls back to VTE auto-detection", () => {
    expect(needsTextSizingDisabled({ vteVersion: "6800", disableTextSizing: "maybe" })).toBe(true)
    expect(needsTextSizingDisabled({ disableTextSizing: "maybe" })).toBe(false)
  })
})

describe("isMacNativeTerminal", () => {
  test("returns true only for Apple Terminal on macOS", () => {
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
