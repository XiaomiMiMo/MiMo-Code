import { describe, expect, test } from "bun:test"
import { buildTipKeys, tipWeight } from "../../../../src/cli/cmd/tui/feature-plugins/home/tips-view"
import { dict as en } from "../../../../src/cli/cmd/tui/i18n/en"
import { dict as es } from "../../../../src/cli/cmd/tui/i18n/es"
import { dict as fr } from "../../../../src/cli/cmd/tui/i18n/fr"
import { dict as ja } from "../../../../src/cli/cmd/tui/i18n/ja"
import { dict as ru } from "../../../../src/cli/cmd/tui/i18n/ru"
import { dict as zh } from "../../../../src/cli/cmd/tui/i18n/zh"
import { dict as zht } from "../../../../src/cli/cmd/tui/i18n/zht"

// buildTipKeys assembles the weighted tip pool. The Tab-cycle tip must only
// mention the Orchestrator agent when the experiment flag is on; otherwise the
// Orchestrator-free variant is used so we never point users at an unreachable
// agent.
describe("buildTipKeys", () => {
  test("promotes localized chat guidance for discovering slash commands", () => {
    const key = "tui.tips.ask_slash_commands"
    expect(buildTipKeys(false, "linux")).toContain(key)
    expect(tipWeight(key)).toBeGreaterThan(tipWeight("tui.tips.multi_skills"))
    Array.of(en, es, fr, ja, ru, zh, zht).forEach((dict) => expect(dict[key]).toBeTruthy())
  })

  test("includes localized guidance for toggling visual modes", () => {
    const key = "tui.tips.vivid"
    expect(buildTipKeys(false, "linux")).toContain(key)
    expect(tipWeight(key)).toBe(tipWeight("tui.tips.theme_mode"))
    Array.of(en, es, fr, ja, ru, zh, zht).forEach((dict) => expect(dict[key]).toContain("{highlight}/vivid{/highlight}"))
  })

  test("omits the Orchestrator tab tip when the flag is off", () => {
    const keys = buildTipKeys(false, "linux")
    expect(keys).toContain("tui.tips.tab_agent")
    expect(keys).not.toContain("tui.tips.tab_agent_orchestrator")
  })

  test("uses the Orchestrator tab tip when the flag is on", () => {
    const keys = buildTipKeys(true, "linux")
    expect(keys).toContain("tui.tips.tab_agent_orchestrator")
    expect(keys).not.toContain("tui.tips.tab_agent")
  })

  test("includes exactly one tab-agent variant regardless of flag", () => {
    for (const enabled of [true, false]) {
      const tabKeys = buildTipKeys(enabled, "linux").filter((k) => k.startsWith("tui.tips.tab_agent"))
      expect(tabKeys).toHaveLength(1)
    }
  })

  test("appends the platform-specific suspend tip", () => {
    expect(buildTipKeys(false, "win32")).toContain("tui.tips.suspend.win")
    expect(buildTipKeys(false, "darwin")).toContain("tui.tips.suspend.unix")
    expect(buildTipKeys(false, "linux")).toContain("tui.tips.suspend.unix")
  })

  test("keeps the free-model promotion before sunset", () => {
    expect(buildTipKeys(false, "linux", false, false)).toContain("tui.tips.free_models")
    expect(buildTipKeys(false, "linux", false, false)).not.toContain("tui.tips.free_api_sunset")
  })

  test("replaces the free promotion with guidance for signed-out users after sunset", () => {
    const keys = buildTipKeys(false, "linux", true, false)
    expect(keys).not.toContain("tui.tips.free_models")
    expect(keys).toContain("tui.tips.free_api_sunset")
  })

  test("does not show sign-in guidance to authenticated Xiaomi users after sunset", () => {
    const keys = buildTipKeys(false, "linux", true, true)
    expect(keys).not.toContain("tui.tips.free_models")
    expect(keys).not.toContain("tui.tips.free_api_sunset")
  })
})
