import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { isWindowsTerminal } from "../src/cli/cmd/tui/util/terminal"

describe("isWindowsTerminal", () => {
  const originalWTSession = process.env.WT_SESSION

  beforeEach(() => {
    delete process.env.WT_SESSION
  })

  afterEach(() => {
    if (originalWTSession !== undefined) {
      process.env.WT_SESSION = originalWTSession
    } else {
      delete process.env.WT_SESSION
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
