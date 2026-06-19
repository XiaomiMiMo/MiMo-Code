import { describe, expect, test } from "bun:test"
import { skillElement } from "../../src/skill"
import { fmt } from "../../src/skill"
import type { Info } from "../../src/skill"

describe("skillElement", () => {
  test("generates correct XML element", () => {
    const result = skillElement("test-skill", "A test skill", "file:///path/to/SKILL.md")
    expect(result).toContain("<skill>")
    expect(result).toContain("<name>test-skill</name>")
    expect(result).toContain("<description>A test skill</description>")
    expect(result).toContain("<location>file:///path/to/SKILL.md</location>")
    expect(result).toContain("</skill>")
  })

  test("handles special characters in description", () => {
    const result = skillElement("skill", "Uses <xml> & \"quotes\"", "file:///a.md")
    expect(result).toContain("<description>Uses <xml> & \"quotes\"</description>")
  })
})

describe("Skill.fmt with skillElement", () => {
  const makeSkill = (name: string, description: string, location: string): Info => ({
    name,
    description,
    location,
  } as Info)

  test("verbose mode generates available_skills XML", () => {
    const skills = [makeSkill("alpha", "First skill", "/a.md"), makeSkill("beta", "Second skill", "/b.md")]
    const result = fmt(skills, { verbose: true })
    expect(result).toContain("<available_skills>")
    expect(result).toContain("</available_skills>")
    expect(result).toContain("<name>alpha</name>")
    expect(result).toContain("<name>beta</name>")
    expect(result).toContain("<description>First skill</description>")
    expect(result).toContain("<description>Second skill</description>")
  })

  test("non-verbose mode generates markdown list", () => {
    const skills = [makeSkill("test", "Test skill", "/test.md")]
    const result = fmt(skills, { verbose: false })
    expect(result).toContain("## Available Skills")
    expect(result).toContain("- **test**: Test skill")
    expect(result).not.toContain("<skill>")
  })

  test("empty list returns message", () => {
    const result = fmt([], { verbose: true })
    expect(result).toBe("No skills are currently available.")
  })

  test("skills are sorted by name", () => {
    const skills = [makeSkill("z-skill", "Z", "/z.md"), makeSkill("a-skill", "A", "/a.md")]
    const result = fmt(skills, { verbose: true })
    const aPos = result.indexOf("<name>a-skill</name>")
    const zPos = result.indexOf("<name>z-skill</name>")
    expect(aPos).toBeLessThan(zPos)
  })
})
