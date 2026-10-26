import { describe, expect, test } from "bun:test"
import path from "path"
import {
  AGENT_CLI_SKILL_NAMES,
  OFFICIAL_SKILL_NAMES,
  shouldExtractBuiltinSkill,
} from "../../src/skill/builtin/extract"

const agentCliRoots = {
  "claude-code": path.join(import.meta.dir, "../../src/skill/builtin/.bundle/claude-code"),
  codex: path.join(import.meta.dir, "../../src/skill/builtin/.bundle/codex"),
  "grok-build": path.join(import.meta.dir, "../../src/skill/builtin/.bundle/grok-build"),
} as const

describe("builtin skills", () => {
  test("agent CLI skills are a dedicated opt-in set, not binary-gated", () => {
    expect([...AGENT_CLI_SKILL_NAMES].toSorted()).toEqual(["claude-code", "codex", "grok-build"])
    expect(OFFICIAL_SKILL_NAMES.has("claude-code")).toBe(false)
    expect(OFFICIAL_SKILL_NAMES.has("codex")).toBe(false)
    expect(OFFICIAL_SKILL_NAMES.has("grok-build")).toBe(false)
    expect(OFFICIAL_SKILL_NAMES.has("pdf-official")).toBe(true)
  })

  test("agent CLI skills extract only when MIMOCODE_ENABLE_AGENT_CLI_SKILLS is on", () => {
    for (const name of AGENT_CLI_SKILL_NAMES) {
      expect(shouldExtractBuiltinSkill(name, { enableAgentCliSkills: false, disableOfficialSkills: false })).toBe(
        false,
      )
      expect(shouldExtractBuiltinSkill(name, { enableAgentCliSkills: true, disableOfficialSkills: false })).toBe(true)
    }
    expect(shouldExtractBuiltinSkill("pdf-official", { enableAgentCliSkills: false, disableOfficialSkills: false })).toBe(
      true,
    )
    expect(shouldExtractBuiltinSkill("pdf-official", { enableAgentCliSkills: false, disableOfficialSkills: true })).toBe(
      false,
    )
    expect(shouldExtractBuiltinSkill("data-analytics", { enableAgentCliSkills: false, disableOfficialSkills: true })).toBe(
      true,
    )
  })

  test("agent CLI skills share an explicit invocation contract", async () => {
    for (const [name, root] of Object.entries(agentCliRoots)) {
      const skill = await Bun.file(path.join(root, "SKILL.md")).text()
      expect(skill).toContain("Load only when the user explicitly authorizes this skill")
      expect(skill).not.toContain("Do not use for general coding or other agent CLIs")
      expect(skill).not.toContain("Invocation contract (all three")
      expect(skill).toContain(
        name === "claude-code"
          ? "confirm the `claude` binary is available"
          : name === "codex"
            ? "confirm the `codex` binary is available"
            : "confirm the `grok` binary is available",
      )
    }
  })

  test("agent CLI skill packages carry no host-only openai.yaml", async () => {
    for (const root of Object.values(agentCliRoots)) {
      expect(await Bun.file(path.join(root, "agents/openai.yaml")).exists()).toBe(false)
    }
  })
})
