import { describe, expect, test } from "bun:test"
import { sidebarToggle, sidebarVisibleFor } from "../../../src/cli/cmd/tui/routes/session/sidebar-state"

const WIDE = true
const NARROW = false

describe("sidebarVisibleFor", () => {
  test("auto follows the terminal width", () => {
    expect(sidebarVisibleFor("auto", WIDE)).toBe(true)
    expect(sidebarVisibleFor("auto", NARROW)).toBe(false)
  })

  test("explicit overrides ignore the terminal width", () => {
    expect(sidebarVisibleFor("show", NARROW)).toBe(true)
    expect(sidebarVisibleFor("hide", WIDE)).toBe(false)
  })
})

describe("sidebarToggle", () => {
  test("a collapse/expand round-trip on a wide terminal ends back at auto", () => {
    const collapsed = sidebarToggle("auto", WIDE)
    expect(collapsed).toBe("hide")
    expect(sidebarVisibleFor(collapsed, WIDE)).toBe(false)

    const expanded = sidebarToggle(collapsed, WIDE)
    expect(expanded).toBe("auto")
    // The regression: an expand used to leave a sticky override that survived a shrink.
    expect(sidebarVisibleFor(expanded, NARROW)).toBe(false)
  })

  test("expanding on a narrow terminal is an explicit override that survives a shrink", () => {
    const expanded = sidebarToggle("auto", NARROW)
    expect(expanded).toBe("show")
    expect(sidebarVisibleFor(expanded, NARROW)).toBe(true)
  })

  test("collapsing an override on a narrow terminal normalises to auto", () => {
    expect(sidebarToggle("show", NARROW)).toBe("auto")
  })

  test("expanding a hidden sidebar on a narrow terminal is an override", () => {
    expect(sidebarToggle("hide", NARROW)).toBe("show")
  })

  test("collapsing an override on a wide terminal stays explicit", () => {
    expect(sidebarToggle("show", WIDE)).toBe("hide")
  })

  test("toggling always flips visibility at the current width", () => {
    for (const preference of ["auto", "show", "hide"] as const) {
      for (const wide of [WIDE, NARROW]) {
        const before = sidebarVisibleFor(preference, wide)
        expect(sidebarVisibleFor(sidebarToggle(preference, wide), wide)).toBe(!before)
      }
    }
  })
})
