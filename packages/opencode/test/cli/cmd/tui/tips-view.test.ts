import { describe, expect, test } from "bun:test"
import { buildTipKeys } from "../../../../src/cli/cmd/tui/feature-plugins/home/tips-view"

// buildTipKeys assembles the weighted tip pool. The Tab-cycle tip must only
// mention the Orchestrator agent when the experiment flag is on; otherwise the
// Orchestrator-free variant is used so we never point users at an unreachable
// agent.
describe("buildTipKeys", () => {
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
})
