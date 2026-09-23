import { describe, expect, test } from "bun:test"
import { buildTipKeys, tipWeight } from "../../../../src/cli/cmd/tui/feature-plugins/home/tips-view"
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

  test("keeps the free-model promotion before sunset", () => {
    expect(buildTipKeys("linux", false, false)).toContain("tui.tips.free_models")
    expect(buildTipKeys("linux", false, false)).not.toContain("tui.tips.free_api_sunset")
  })

  test("replaces the free promotion with guidance for signed-out users after sunset", () => {
    const keys = buildTipKeys("linux", true, false)
    expect(keys).not.toContain("tui.tips.free_models")
    expect(keys).toContain("tui.tips.free_api_sunset")
  })

  test("does not show sign-in guidance to authenticated Xiaomi users after sunset", () => {
    const keys = buildTipKeys("linux", true, true)
    expect(keys).not.toContain("tui.tips.free_models")
    expect(keys).not.toContain("tui.tips.free_api_sunset")
  })
})
