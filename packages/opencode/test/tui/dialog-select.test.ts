import { describe, expect, test } from "bun:test"
import { shouldShowFilterInput } from "../../src/cli/cmd/tui/ui/dialog-select"

describe("DialogSelect filter input", () => {
  test("shows the input for built-in filtering", () => {
    expect(shouldShowFilterInput({})).toBe(true)
    expect(shouldShowFilterInput({ skipFilter: false })).toBe(true)
  })

  test("hides the input when filtering is skipped and no external filter exists", () => {
    expect(shouldShowFilterInput({ skipFilter: true })).toBe(false)
  })

  test("shows the input for external filtering even when built-in filtering is skipped", () => {
    expect(shouldShowFilterInput({ skipFilter: true, onFilter: () => {} })).toBe(true)
  })
})
