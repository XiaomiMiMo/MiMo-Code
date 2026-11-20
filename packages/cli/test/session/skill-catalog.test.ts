import { describe, expect, test } from "bun:test"
import {
  catalogState,
  diffSkillCatalog,
  isLegacySkillCatalogPart,
  readSkillReminderMeta,
  skillReminderRev,
  stripLegacySkillCatalog,
} from "../../src/session/skill-catalog"
import { renderSkillCatalogReminder } from "../../src/session/skill-reminder"

const skill = (name: string, description = `${name} description`) => ({
  name,
  description,
  location: `/tmp/example/skills/${name}/SKILL.md`,
})

describe("skill catalog diff", () => {
  test("first catalog is a full entry; an empty catalog announces nothing", () => {
    expect(diffSkillCatalog({ announced: undefined, current: [] })).toBeUndefined()
    const change = diffSkillCatalog({ announced: undefined, current: [skill("zeta"), skill("alpha")] })
    expect(change?.kind).toBe("entry")
    if (change?.kind !== "entry") throw new Error("expected entry")
    expect(change.skills.map((item) => item.name)).toEqual(["alpha", "zeta"])
    expect(Object.keys(change.meta.skills)).toEqual(["alpha", "zeta"])
    const text = renderSkillCatalogReminder(change)
    expect(text.startsWith("<system-reminder>\n")).toBe(true)
    expect(text.endsWith("\n</system-reminder>")).toBe(true)
    expect(text.indexOf("<name>alpha</name>")).toBeLessThan(text.indexOf("<name>zeta</name>"))
  })

  test("unchanged catalog announces nothing", () => {
    const current = [skill("alpha"), skill("beta")]
    expect(diffSkillCatalog({ announced: catalogState(current), current })).toBeUndefined()
  })

  test("delta carries added and changed skills in full and removed skills by name", () => {
    const announced = catalogState([skill("alpha"), skill("beta"), skill("gone")])
    const change = diffSkillCatalog({
      announced,
      current: [skill("alpha"), skill("beta", "edited"), skill("new")],
    })
    expect(change?.kind).toBe("delta")
    if (change?.kind !== "delta") throw new Error("expected delta")
    expect(change.changed.map((item) => item.name)).toEqual(["beta", "new"])
    expect(change.removed).toEqual(["gone"])
    expect(Object.keys(change.meta.skills)).toEqual(["alpha", "beta", "new"])
    const text = renderSkillCatalogReminder(change)
    expect(text).toContain("<name>beta</name>")
    expect(text).toContain("<description>edited</description>")
    expect(text).not.toContain("<name>alpha</name>")
    expect(text).toContain("Removed skills (no longer available; do not load or follow them): gone")
  })

  test("removing every skill retracts the whole announced catalog", () => {
    const change = diffSkillCatalog({ announced: catalogState([skill("alpha")]), current: [] })
    expect(change).toMatchObject({ kind: "delta", changed: [], removed: ["alpha"], meta: { skills: {} } })
  })

  test("a moved skill counts as changed", () => {
    const moved = { ...skill("alpha"), location: "/tmp/example/other/alpha/SKILL.md" }
    const change = diffSkillCatalog({ announced: catalogState([skill("alpha")]), current: [moved] })
    expect(change?.kind).toBe("delta")
  })

  test("rev identifies the resulting catalog state", () => {
    const state = catalogState([skill("alpha")])
    expect(skillReminderRev({ kind: "entry", skills: state })).toMatch(/^skills:entry:[0-9a-f]{64}$/)
    expect(skillReminderRev({ kind: "entry", skills: state })).toBe(skillReminderRev({ kind: "entry", skills: { ...state } }))
    expect(skillReminderRev({ kind: "delta", skills: state })).not.toBe(skillReminderRev({ kind: "entry", skills: state }))
  })
})

describe("skill reminder metadata", () => {
  test("reads well-formed metadata and rejects anything else", () => {
    expect(readSkillReminderMeta({ kind: "delta", skills: { a: "x" } })).toEqual({ kind: "delta", skills: { a: "x" } })
    expect(readSkillReminderMeta(undefined)).toBeUndefined()
    expect(readSkillReminderMeta({ kind: "other", skills: {} })).toBeUndefined()
    expect(readSkillReminderMeta({ kind: "entry", skills: { a: 1 } })).toBeUndefined()
  })

  test("legacy user-side catalogs are the untagged synthetic ones", () => {
    const text = "<system-reminder>\nSkills available in this session:\n</system-reminder>"
    expect(isLegacySkillCatalogPart({ synthetic: true, text })).toBe(true)
    expect(isLegacySkillCatalogPart({ synthetic: false, text })).toBe(false)
    expect(isLegacySkillCatalogPart({ synthetic: true, text, metadata: { skillReminder: { kind: "entry", skills: {} } } })).toBe(false)
  })
})

describe("legacy system catalog strip", () => {
  test("removes the verbose catalog block and its separator", () => {
    const system = [
      [
        "base prompt",
        "Skills available in this session:\n<available_skills>\n  <skill>\n    <name>a</name>\n  </skill>\n</available_skills>",
        "instructions",
      ].join("\n\n"),
    ]
    expect(stripLegacySkillCatalog(system)).toEqual(["base prompt\n\ninstructions"])
  })

  test("removes the empty-catalog sentence", () => {
    expect(stripLegacySkillCatalog(["base\n\nSkills available in this session:\nNo skills are currently available."]))
      .toEqual(["base"])
  })

  test("leaves systems without a catalog unchanged", () => {
    const system = ["base prompt\n\ninstructions"]
    expect(stripLegacySkillCatalog(system)).toEqual(system)
  })
})
