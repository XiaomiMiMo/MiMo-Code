import { describe, expect, test } from "bun:test"
import { shouldAbortBusySession } from "../../../../src/cli/cmd/tui/component/prompt/interrupt"

describe("prompt interrupt", () => {
  test("app exit key aborts a busy session even when draft input exists", () => {
    expect(
      shouldAbortBusySession({
        appExit: true,
        sessionID: "ses_busy",
        status: { type: "busy" },
      }),
    ).toBe(true)
  })

  test("does not abort without a session or while idle", () => {
    expect(shouldAbortBusySession({ appExit: true, status: { type: "busy" } })).toBe(false)
    expect(shouldAbortBusySession({ appExit: true, sessionID: "ses_idle", status: { type: "idle" } })).toBe(false)
    expect(shouldAbortBusySession({ appExit: false, sessionID: "ses_busy", status: { type: "busy" } })).toBe(false)
  })
})
