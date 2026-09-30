import { describe, expect, test } from "bun:test"
import path from "path"
import { isBuiltinSkillInstalled } from "../../src/skill/builtin/extract"

describe("builtin skills", () => {
  test("loads Claude Code skill only when claude is installed", () => {
    expect(isBuiltinSkillInstalled("claude-code", (command) => (command === "claude" ? "/bin/claude" : null))).toBe(
      true,
    )
    expect(isBuiltinSkillInstalled("claude-code", () => null)).toBe(false)
  })

  test("describes Claude Code as explicitly invoked only", async () => {
    const skill = await Bun.file(
      path.join(import.meta.dir, "../../src/skill/builtin/.bundle/claude-code/SKILL.md"),
    ).text()

    expect(skill).toContain("only when the user explicitly requests Claude Code or names this skill")
    expect(skill).not.toContain("even if the user doesn't say 'Claude Code'")
  })

  test("loads Codex skill only when codex is installed", () => {
    expect(isBuiltinSkillInstalled("codex", (command) => (command === "codex" ? "/bin/codex" : null))).toBe(true)
    expect(isBuiltinSkillInstalled("codex", () => null)).toBe(false)
  })

  test("keeps Grok Build explicitly invoked", async () => {
    const root = path.join(import.meta.dir, "../../src/skill/builtin/.bundle/grok-build")
    const skill = await Bun.file(path.join(root, "SKILL.md")).text()
    const metadata = await Bun.file(path.join(root, "agents/openai.yaml")).text()

    expect(skill).toContain("Invoke only when the user explicitly requests the `grok-build` skill")
    expect(skill).toContain("do not invoke for general coding")
    expect(metadata).toContain("allow_implicit_invocation: false")
  })

  test("does not gate unrelated builtin skills", () => {
    expect(isBuiltinSkillInstalled("pdf-official", () => null)).toBe(true)
  })
})
