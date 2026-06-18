import { describe, expect, test } from "bun:test"
import PROMPT_CORE_BEHAVIOR from "../../src/session/prompt/core-behavior.txt"
import BUILD_SWITCH from "../../src/session/prompt/build-switch.txt"
import MAX_STEPS from "../../src/session/prompt/max-steps.txt"
import { RECOVERY_PROMPT_MILD, RECOVERY_PROMPT_STRONG } from "../../src/session/prompt/text-loop-recovery"
import { SystemPrompt } from "../../src/session/system"

describe("Core behavior prompt injection verification", () => {
  test("all models use the same core behavior prompt", () => {
    // 无论什么模型，都应该返回同一个 prompt
    const claudeModel = { api: { id: "claude-sonnet-4-20250514" } } as any
    const gptModel = { api: { id: "gpt-4o" } } as any
    const geminiModel = { api: { id: "gemini-2.5-pro" } } as any

    expect(SystemPrompt.provider(claudeModel)).toEqual([PROMPT_CORE_BEHAVIOR])
    expect(SystemPrompt.provider(gptModel)).toEqual([PROMPT_CORE_BEHAVIOR])
    expect(SystemPrompt.provider(geminiModel)).toEqual([PROMPT_CORE_BEHAVIOR])
  })

  test("core-behavior prompt contains all MiMoCode-specific behavioral directives", () => {
    const requiredDirectives = [
      // MiMoCode core features
      "Actor Delegation",
      "Task Tool",
      "Memory System",
      "Skill System",
      "Plan Mode",
      "Verification Loop",
      // General behavioral directives
      "Thinking & Analysis Rules",
      "Professional objectivity",
      "Output Style",
      "Tool Usage Strategy",
      "Executing Actions with Care",
      "Git Safety",
      "Read at least 3 existing implementations",
      "Parallel execution",
      "file_path:line_number",
      "Do NOT add comments unless explicitly asked",
      "NEVER commit changes unless the user explicitly asks",
      "Prioritize technical accuracy over validating",
    ]

    for (const directive of requiredDirectives) {
      expect(PROMPT_CORE_BEHAVIOR).toContain(directive)
    }
  })

  test("core-behavior prompt has reasonable length", () => {
    expect(PROMPT_CORE_BEHAVIOR.length).toBeGreaterThan(5000)
    expect(PROMPT_CORE_BEHAVIOR.length).toBeLessThan(25000)
  })
})

describe("Runtime system-reminder injection verification", () => {
  test("build-switch.txt contains execution mode instructions", () => {
    expect(BUILD_SWITCH).toContain("EXECUTION mode")
    expect(BUILD_SWITCH).toContain("What you MUST do")
    expect(BUILD_SWITCH).toContain("What you MUST NOT do")
  })

  test("max-steps.txt contains structured response requirements", () => {
    expect(MAX_STEPS).toContain("MAXIMUM STEPS")
    expect(MAX_STEPS).toContain("text ONLY")
    expect(MAX_STEPS).toContain("summary of what was accomplished")
  })

  test("RECOVERY_PROMPT_MILD contains loop detection instructions", () => {
    expect(RECOVERY_PROMPT_MILD).toContain("LOOP DETECTED")
    expect(RECOVERY_PROMPT_MILD).toContain("STOP immediately")
    expect(RECOVERY_PROMPT_MILD).toContain("Re-read the original user request")
  })

  test("RECOVERY_PROMPT_STRONG contains critical loop instructions", () => {
    expect(RECOVERY_PROMPT_STRONG).toContain("CRITICAL FAILURE")
    expect(RECOVERY_PROMPT_STRONG).toContain("ABANDON your current plan")
    expect(RECOVERY_PROMPT_STRONG).toContain("Propose 2-3 alternative approaches")
  })
})
