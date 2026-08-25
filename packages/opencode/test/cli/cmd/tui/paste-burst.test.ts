import { describe, expect, test } from "bun:test"
import { PasteBurstGuard } from "../../../../src/cli/cmd/tui/component/prompt/paste-burst"

// A terminal without bracketed paste delivers a paste as a rapid stream of
// ordinary key events, so every newline inside the pasted text looks like
// Enter and submits one message per line (#2186). The guard must treat an
// Enter that lands within the burst window after a printable key as part of
// the paste, while never delaying a real Enter press.
describe("PasteBurstGuard", () => {
  test("allows submit when Enter follows typing at human speed", () => {
    const guard = new PasteBurstGuard()
    guard.key("h", 1000)
    guard.key("i", 1080)
    // Enter 120ms after the last character — a human press.
    expect(guard.canSubmit(1200)).toBe(true)
  })

  test("blocks submit when Enter arrives inside a paste burst", () => {
    const guard = new PasteBurstGuard()
    // Pasted keystream: characters land microseconds apart.
    const t0 = 1000
    ;["l", "i", "n", "e", "1"].forEach((ch, i) => guard.key(ch, t0 + i))
    // Enter 2ms after the last pasted character.
    expect(guard.canSubmit(t0 + 7)).toBe(false)
  })

  test("keeps blocking across consecutive pasted lines, then recovers", () => {
    const guard = new PasteBurstGuard()
    const t0 = 1000
    // line 1 + Enter
    ;["a", "b"].forEach((ch, i) => guard.key(ch, t0 + i))
    expect(guard.canSubmit(t0 + 3)).toBe(false)
    // line 2 + Enter, still inside the same burst
    ;["c", "d"].forEach((ch, i) => guard.key(ch, t0 + 4 + i))
    expect(guard.canSubmit(t0 + 7)).toBe(false)
    // Long after the paste, a human Enter submits again.
    expect(guard.canSubmit(t0 + 500)).toBe(true)
  })

  test("non-printable keys do not arm the guard", () => {
    const guard = new PasteBurstGuard()
    guard.key("return", 1000)
    guard.key("escape", 1001)
    guard.key(undefined, 1002)
    expect(guard.canSubmit(1003)).toBe(true)
  })

  test("a printable key long before Enter does not block submit", () => {
    const guard = new PasteBurstGuard()
    guard.key("x", 1000)
    expect(guard.canSubmit(1050)).toBe(true)
  })

  test("custom window is respected", () => {
    const guard = new PasteBurstGuard(50)
    guard.key("x", 1000)
    expect(guard.canSubmit(1030)).toBe(false)
    expect(guard.canSubmit(1051)).toBe(true)
  })
})
