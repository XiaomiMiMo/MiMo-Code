import { describe, expect, test } from "bun:test"
import { CommandInput, PromptInput } from "../../src/session/prompt"
import { executionProfileSystemSections } from "../../src/session/llm"

const policy = {
  includeMimocodeBundled: true as const,
  allowedDesktopSkillNames: ["research"],
  explicitlySelectedSkillNames: ["creative"],
}

describe("request-scoped execution profile input", () => {
  test("prompt accepts the profile, prompt replacement, Codex mode, and skill policy together", () => {
    const result = PromptInput.safeParse({
      sessionID: "ses_test",
      model: { providerID: "xiaomi", modelID: "mimo-v2.5-pro" },
      parts: [{ type: "text", text: "hello" }],
      system: "profile prompt",
      executionProfile: "gpt",
      replaceAgentPrompt: true,
      codexMode: true,
      skillPolicy: policy,
    })
    expect(result.success).toBe(true)
  })

  test("slash command accepts the same request-scoped profile contract", () => {
    const result = CommandInput.safeParse({
      sessionID: "ses_test",
      command: "review",
      arguments: "now",
      system: "profile prompt",
      executionProfile: "claude",
      replaceAgentPrompt: true,
      codexMode: false,
      skillPolicy: policy,
    })
    expect(result.success).toBe(true)
  })

  test("rejects unknown profiles and unstructured skill policies", () => {
    expect(PromptInput.safeParse({
      sessionID: "ses_test",
      parts: [{ type: "text", text: "hello" }],
      executionProfile: "unknown",
      skillPolicy: { allowedDesktopSkillNames: "research" },
    }).success).toBe(false)
  })

  test("profile prompt replaces the agent personality but keeps dynamic additions", () => {
    expect(executionProfileSystemSections(
      ["desktop base"],
      ["runtime guard"],
      { replaceAgentPrompt: true, system: "gpt profile" },
    )).toEqual(["runtime guard", "gpt profile"])
    expect(executionProfileSystemSections(
      ["desktop base"],
      ["runtime guard"],
      { replaceAgentPrompt: false, system: "turn system" },
    )).toEqual(["desktop base", "runtime guard", "turn system"])
  })
})
