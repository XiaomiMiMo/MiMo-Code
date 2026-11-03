import { describe, expect, test } from "bun:test"
import { dict as en } from "../../src/cli/cmd/tui/i18n/en"
import { dict as zh } from "../../src/cli/cmd/tui/i18n/zh"
import { dict as zht } from "../../src/cli/cmd/tui/i18n/zht"
import { deviceName } from "../../src/phone/runtime"

describe("phone connection", () => {
  test("the computer is listed by a bounded, printable name", () => {
    expect(deviceName("dev-box")).toBe("MiMo Code (dev-box)")
    expect(deviceName("")).toBe("MiMo Code")
    expect(deviceName("bad\u0007name\n")).toBe("MiMo Code (badname)")
    const long = deviceName("界".repeat(200))
    expect([...long].length).toBeLessThanOrEqual(80)
  })

  test("every state, reason and outcome the menu can show has its text in each shipped language", () => {
    const keys = [
      "tui.command.phone",
      ...["off", "starting", "online", "reconnecting", "unavailable"].map((state) => `tui.phone.state.${state}`),
      ...[
        "secure_storage_unavailable",
        "not_signed_in",
        "account_rejected",
        "service_without_cli",
        "state_unreadable",
        "registration_conflict",
        "in_use",
      ].map((reason) => `tui.phone.unavailable.${reason}`),
      ...["missing", "unreadable", "invalid", "expired"].map((problem) => `tui.phone.identity.${problem}`),
      ...["rejected", "expired", "cancelled", "failed"].map((outcome) => `tui.phone.outcome.${outcome}`),
    ]
    for (const dict of [en, zh, zht] as Record<string, string>[]) {
      for (const key of keys) expect(dict[key], key).toEqual(expect.any(String))
    }
  })
})
