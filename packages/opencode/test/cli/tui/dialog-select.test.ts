import { expect, test } from "bun:test"

const { DEFAULT_THEMES, resolveTheme } = await import("../../../src/cli/cmd/tui/context/theme")
const { dialogSelectSurfaceBackground } = await import("../../../src/cli/cmd/tui/ui/dialog-select")

test("dialog select keeps opaque theme panel background unchanged", () => {
  const theme = resolveTheme(DEFAULT_THEMES.mimocode, "light")

  expect(dialogSelectSurfaceBackground(theme)).toBeUndefined()
})

test("dialog select uses menu background when panel is transparent", () => {
  const theme = resolveTheme(DEFAULT_THEMES["lucent-orng"], "light")

  expect(theme.backgroundPanel.a).toBe(0)
  expect(theme.backgroundMenu.a).toBeGreaterThan(0)
  expect(dialogSelectSurfaceBackground(theme)).toBe(theme.backgroundMenu)
})
