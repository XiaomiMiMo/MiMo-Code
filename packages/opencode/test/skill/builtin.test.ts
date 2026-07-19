import { describe, expect, test } from "bun:test"
import { isBuiltinSkillInstalled } from "../../src/skill/builtin/extract"

describe("builtin skills", () => {
  test("loads Claude Code skill only when claude is installed", () => {
    expect(isBuiltinSkillInstalled("claude-code", (command) => (command === "claude" ? "/bin/claude" : null))).toBe(
      true,
    )
    expect(isBuiltinSkillInstalled("claude-code", () => null)).toBe(false)
  })

  test("loads Codex skill only when codex is installed", () => {
    expect(isBuiltinSkillInstalled("codex", (command) => (command === "codex" ? "/bin/codex" : null))).toBe(true)
    expect(isBuiltinSkillInstalled("codex", () => null)).toBe(false)
  })

  test("does not gate unrelated builtin skills", () => {
    expect(isBuiltinSkillInstalled("pdf-official", () => null)).toBe(true)
  })
})
