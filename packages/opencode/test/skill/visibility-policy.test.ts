import { describe, expect, test } from "bun:test"
import { applyVisibilityPolicy } from "../../src/skill/policy"
import type { Skill } from "../../src/skill"

const item = (name: string, input: Partial<Skill.Info> = {}): Skill.Info => ({
  name,
  description: name,
  location: `/skills/${name}/SKILL.md`,
  content: name,
  ...input,
})

describe("request-scoped skill visibility", () => {
  test("keeps bundled defaults and allowed desktop skills", () => {
    const result = applyVisibilityPolicy([
      item("builtin", { bundled: true }),
      item("desktop"),
      item("hidden"),
    ], {
      includeMimocodeBundled: true,
      allowedDesktopSkillNames: ["desktop"],
      explicitlySelectedSkillNames: [],
    })
    expect(result.map((skill) => skill.name)).toEqual(["builtin", "desktop"])
  })

  test("explicit selection restores a filtered or model-disabled skill", () => {
    const result = applyVisibilityPolicy([
      item("creative", { disable_model_invocation: true }),
      item("other"),
    ], {
      includeMimocodeBundled: true,
      allowedDesktopSkillNames: [],
      explicitlySelectedSkillNames: ["creative"],
    })
    expect(result.map((skill) => skill.name)).toEqual(["creative"])
  })
})
