import { describe, expect, test } from "bun:test"
import { Command } from "../../src/command"
import { deepResearchTemplate } from "../../src/command"

describe("/deep-research command", () => {
  test("Default has the deep-research name", () => {
    expect(Command.Default.DEEP_RESEARCH).toBe("deep-research")
  })

  test("template instructs a run-by-name workflow call weaving in the user args", () => {
    const t = deepResearchTemplate()
    expect(t).toContain("$ARGUMENTS")
    expect(t).toContain('name: "deep-research"')
    expect(t.toLowerCase()).toContain("workflow")
  })
})
