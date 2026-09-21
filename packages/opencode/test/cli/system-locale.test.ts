import { describe, expect, test } from "bun:test"
import { detectSystemLocale } from "../../src/cli/cmd/tui/util/system-locale"

describe("detectSystemLocale", () => {
  test("uses explicit locale environment before timezone fallback", () => {
    expect(
      detectSystemLocale({
        env: { LANG: "en_US.UTF-8" },
        intlLocale: "zh-CN",
        timeZone: "Asia/Shanghai",
      }),
    ).toBe("en")
  })

  test("uses Intl locale before timezone fallback", () => {
    expect(
      detectSystemLocale({
        env: {},
        intlLocale: "en-US",
        timeZone: "Asia/Shanghai",
      }),
    ).toBe("en")
  })

  test("uses timezone as a last resort", () => {
    expect(
      detectSystemLocale({
        env: {},
        intlLocale: "C",
        timeZone: "Asia/Shanghai",
      }),
    ).toBe("zh")
  })
})
