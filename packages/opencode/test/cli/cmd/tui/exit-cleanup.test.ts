import { describe, expect, test } from "bun:test"
import { terminalExitCleanupSequence, terminalExitSignals } from "../../../../src/cli/cmd/tui/context/exit"

describe("terminalExitCleanupSequence", () => {
  test("disables mouse tracking when resetting the terminal", () => {
    expect(terminalExitCleanupSequence).toContain("\x1b[?1000l")
    expect(terminalExitCleanupSequence).toContain("\x1b[?1002l")
    expect(terminalExitCleanupSequence).toContain("\x1b[?1003l")
    expect(terminalExitCleanupSequence).toContain("\x1b[?1006l")
    expect(terminalExitCleanupSequence).toContain("\x1b[0m")
    expect(terminalExitCleanupSequence).toContain("\x1b[?25h")
    expect(terminalExitCleanupSequence).toContain("\x1b]110\x07")
    expect(terminalExitCleanupSequence).toContain("\x1b]111\x07")
    expect(terminalExitCleanupSequence).toContain("\x1b]112\x07")
  })

  test("runs cleanup for external termination signals", () => {
    expect(terminalExitSignals).toEqual(["SIGHUP", "SIGINT", "SIGTERM"])
  })
})
