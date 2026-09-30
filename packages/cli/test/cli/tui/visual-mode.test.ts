import { describe, expect, test } from "bun:test"
import { resolveVisualMode, toggleVisualMode, visualMotionEnabled } from "@/cli/cmd/tui/context/visual"

describe("TUI visual mode", () => {
  test("defaults missing and invalid state to vivid", () => {
    expect(resolveVisualMode(undefined)).toBe("vivid")
    expect(resolveVisualMode("unknown")).toBe("vivid")
  })

  test("preserves the minimal preference", () => {
    expect(resolveVisualMode("minimal")).toBe("minimal")
  })

  test("toggles the persisted visual mode", () => {
    expect(toggleVisualMode(undefined)).toBe("minimal")
    expect(toggleVisualMode("vivid")).toBe("minimal")
    expect(toggleVisualMode("minimal")).toBe("vivid")
  })

  test("only enables cosmetic motion for vivid visuals with animations enabled", () => {
    expect(visualMotionEnabled("minimal", true)).toBe(false)
    expect(visualMotionEnabled("minimal", false)).toBe(false)
    expect(visualMotionEnabled("vivid", false)).toBe(false)
    expect(visualMotionEnabled("vivid", true)).toBe(true)
  })
})
