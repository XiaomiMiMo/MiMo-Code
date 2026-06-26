import { describe, expect, test } from "bun:test"
import { messageScrollDelta } from "../../../src/cli/cmd/tui/routes/session"

describe("messageScrollDelta", () => {
  test("uses a full viewport for page keybinds", () => {
    expect(messageScrollDelta("messages_page_up", 40)).toBe(-40)
    expect(messageScrollDelta("messages_page_down", 40)).toBe(40)
  })

  test("uses half a viewport for half-page keybinds", () => {
    expect(messageScrollDelta("messages_half_page_up", 40)).toBe(-20)
    expect(messageScrollDelta("messages_half_page_down", 40)).toBe(20)
  })
})
