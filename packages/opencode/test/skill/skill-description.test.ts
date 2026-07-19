import { describe, test, expect } from "bun:test"
import { resolveSkillSlash, skillDescription, skillSlashAliases } from "../../src/cli/cmd/tui/i18n/skill"
import { dict as en } from "../../src/cli/cmd/tui/i18n/en"
import { dict as es } from "../../src/cli/cmd/tui/i18n/es"
import { dict as fr } from "../../src/cli/cmd/tui/i18n/fr"
import { dict as ja } from "../../src/cli/cmd/tui/i18n/ja"
import { dict as ru } from "../../src/cli/cmd/tui/i18n/ru"
import { dict as zh } from "../../src/cli/cmd/tui/i18n/zh"
import { dict as zht } from "../../src/cli/cmd/tui/i18n/zht"

describe("skillDescription", () => {
  const t = (key: string) => {
    const translations: Record<string, string> = {
      "tui.skill.evolve.description": "Translated evolve description",
      "tui.skill.compose:plan.description": "Translated compose plan",
    }
    return translations[key] as string
  }

  test("returns fallback for non-bundled skill", () => {
    expect(skillDescription(t, "my-custom-skill", "Custom description", false)).toBe("Custom description")
  })

  test("returns fallback when bundled is undefined", () => {
    expect(skillDescription(t, "evolve", "Fallback")).toBe("Fallback")
  })

  test("returns translation for bundled builtin skill", () => {
    expect(skillDescription(t, "evolve", "Fallback", true)).toBe("Translated evolve description")
  })

  test("returns translation for bundled compose skill", () => {
    expect(skillDescription(t, "compose:plan", "Fallback", true)).toBe("Translated compose plan")
  })

  test("returns fallback when translation key is missing", () => {
    expect(skillDescription(t, "unknown-bundled", "Fallback", true)).toBe("Fallback")
  })

  test("user override: same name as builtin but not bundled shows fallback", () => {
    expect(skillDescription(t, "evolve", "User custom evolve", false)).toBe("User custom evolve")
  })

  test("returns localized slash aliases only for bundled skills", () => {
    const translate = (key: string) => ({ "tui.skill.frontend-design.slash": "前端设计|界面设计" })[key] as string
    expect(skillSlashAliases(translate, "frontend-design", true)).toEqual(["前端设计", "界面设计"])
    expect(skillSlashAliases(translate, "frontend-design", false)).toEqual([])
  })

  test("resolves a localized slash alias to its bundled skill name", () => {
    const translate = (key: string) => ({ "tui.skill.frontend-design.slash": "前端设计" })[key] as string
    expect(
      resolveSkillSlash(translate, "前端设计", [
        { name: "frontend-design", source: "skill", bundled: true },
        { name: "other", source: "skill", bundled: true },
      ]),
    ).toBe("frontend-design")
    expect(resolveSkillSlash(translate, "前端设计", [{ name: "frontend-design", source: "command", bundled: true }])).toBe(
      "frontend-design",
    )
    expect(resolveSkillSlash(translate, "前端设计", [{ name: "frontend-design", source: "skill" }])).toBeUndefined()
  })

  test("every localized bundled skill has a unique Chinese slash alias", () => {
    for (const dict of [zh, zht]) {
      const descriptions = Object.keys(dict).filter(
        (key) => key.startsWith("tui.skill.") && key.endsWith(".description"),
      )
      for (const key of descriptions) {
        expect(dict[key.replace(/\.description$/, ".slash") as keyof typeof dict]).toBeTruthy()
      }
      const aliases = Object.entries(dict)
        .filter(([key]) => key.startsWith("tui.skill.") && key.endsWith(".slash"))
        .flatMap(([, value]) => value.split("|"))
      expect(new Set(aliases).size).toBe(aliases.length)
    }
  })

  test("codex CLI skills have descriptions in every TUI locale", () => {
    for (const dict of [en, es, fr, ja, ru, zh, zht]) {
      expect(dict["tui.skill.codex.description"]).toBeTruthy()
      expect(dict["tui.skill.claude-code.description"]).toBeTruthy()
    }
  })

  test("data analytics, product design, and sales skills have descriptions in every TUI locale", () => {
    for (const dict of [en, es, fr, ja, ru, zh, zht]) {
      expect(dict["tui.skill.data-analytics.description"]).toBeTruthy()
      expect(dict["tui.skill.product-design.description"]).toBeTruthy()
      expect(dict["tui.skill.sales.description"]).toBeTruthy()
    }
  })
})
