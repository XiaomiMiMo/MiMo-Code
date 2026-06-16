import { test, expect, describe } from "bun:test"
import { ALL_SOURCES, type Source } from "../../src/session/external-import"

// [TP-R3-01] runAll() structure
describe("external-import", () => {
  test("ALL_SOURCES contains all three sources", () => {
    expect(ALL_SOURCES).toContain("cc")
    expect(ALL_SOURCES).toContain("codex")
    expect(ALL_SOURCES).toContain("opencode")
    expect(ALL_SOURCES).toHaveLength(3)
  })

  test("Source type accepts valid values", () => {
    const valid: Source[] = ["cc", "codex", "opencode"]
    expect(valid).toEqual([...ALL_SOURCES])
  })
})
