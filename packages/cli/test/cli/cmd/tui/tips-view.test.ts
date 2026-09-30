import { describe, expect, test } from "bun:test"
import { buildTipKeys, pickDisplayKey, tipWeight } from "../../../../src/cli/cmd/tui/feature-plugins/home/tips-view"
import { dict as en } from "../../../../src/cli/cmd/tui/i18n/en"
import { dict as es } from "../../../../src/cli/cmd/tui/i18n/es"
import { dict as fr } from "../../../../src/cli/cmd/tui/i18n/fr"
import { dict as ja } from "../../../../src/cli/cmd/tui/i18n/ja"
import { dict as ru } from "../../../../src/cli/cmd/tui/i18n/ru"
import { dict as zh } from "../../../../src/cli/cmd/tui/i18n/zh"
import { dict as zht } from "../../../../src/cli/cmd/tui/i18n/zht"

// buildTipKeys assembles the weighted tip pool.
describe("buildTipKeys", () => {
  test("promotes localized chat guidance for discovering slash commands", () => {
    const key = "tui.tips.ask_slash_commands"
    expect(buildTipKeys("linux")).toContain(key)
    expect(tipWeight(key)).toBeGreaterThan(tipWeight("tui.tips.multi_skills"))
    Array.of(en, es, fr, ja, ru, zh, zht).forEach((dict) => expect(dict[key]).toBeTruthy())
  })

  test("includes localized guidance for toggling visual modes", () => {
    const key = "tui.tips.vivid"
    expect(buildTipKeys("linux")).toContain(key)
    expect(tipWeight(key)).toBe(tipWeight("tui.tips.theme_mode"))
    Array.of(en, es, fr, ja, ru, zh, zht).forEach((dict) => expect(dict[key]).toContain("{highlight}/vivid{/highlight}"))
  })

  test("includes exactly one tab-agent tip", () => {
    const tabKeys = buildTipKeys("linux").filter((k) => k.startsWith("tui.tips.tab_agent"))
    expect(tabKeys).toEqual(["tui.tips.tab_agent"])
  })

  test("appends the platform-specific suspend tip", () => {
    expect(buildTipKeys("win32")).toContain("tui.tips.suspend.win")
    expect(buildTipKeys("darwin")).toContain("tui.tips.suspend.unix")
    expect(buildTipKeys("linux")).toContain("tui.tips.suspend.unix")
  })

  test("keeps the login tip available for credential-less installs", () => {
    expect(buildTipKeys("linux")).toContain("tui.tips.login")
    Array.of(en, es, fr, ja, ru, zh, zht).forEach((dict) => expect(dict["tui.tips.login"]).toBeTruthy())
  })
})

describe("pickDisplayKey", () => {
  test("forces the login tip when no provider is authenticated", () => {
    expect(
      pickDisplayKey({ agentName: "build", authenticatedCount: 0, rotationKey: "tui.tips.theme" }),
    ).toBe("tui.tips.login")
  })

  test("keeps the rotation tip once any provider is authenticated", () => {
    expect(
      pickDisplayKey({ agentName: "build", authenticatedCount: 1, rotationKey: "tui.tips.theme" }),
    ).toBe("tui.tips.theme")
  })

  test("compose deprecation outranks the login tip", () => {
    expect(
      pickDisplayKey({ agentName: "compose", authenticatedCount: 0, rotationKey: "tui.tips.theme" }),
    ).toBe("tui.tips.compose_next")
  })
})
