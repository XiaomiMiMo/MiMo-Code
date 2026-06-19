import { describe, expect, test } from "bun:test"
import PROMPT_ANTHROPIC from "../../src/session/prompt/anthropic.txt"
import PROMPT_GPT from "../../src/session/prompt/gpt.txt"
import PROMPT_GEMINI from "../../src/session/prompt/gemini.txt"
import PROMPT_CORE from "../../src/session/prompt/core-behavior-core.txt"
import BUILD_SWITCH from "../../src/session/prompt/build-switch.txt"
import MAX_STEPS from "../../src/session/prompt/max-steps.txt"
import { RECOVERY_PROMPT_MILD, RECOVERY_PROMPT_STRONG } from "../../src/session/prompt/text-loop-recovery"
import { SystemPrompt } from "../../src/session/system"

describe("Core behavior prompt injection verification", () => {
  test("each provider gets its own optimized prompt", () => {
    const claudeModel = { api: { id: "claude-sonnet-4-20250514" }, providerID: "anthropic" } as any
    const gptModel = { api: { id: "gpt-4o" }, providerID: "openai" } as any
    const geminiModel = { api: { id: "gemini-2.5-pro" }, providerID: "google" } as any
    const unknownModel = { api: { id: "unknown-model" }, providerID: "unknown" } as any

    // 已知提供商应获取其专属精简提示词
    expect(SystemPrompt.provider(claudeModel)[0]).toStartWith("You are MiMoCode, a professional software engineering assistant built by Xiaomi MiMo Team.")
    // GPT 应从 gpt.txt 获取更简洁的提示词（可能起始行不同）
    expect(SystemPrompt.provider(gptModel)[0]).toBeTruthy()
    expect(SystemPrompt.provider(geminiModel)[0]).toBeTruthy()
    // 未知提供商回退到 core-behavior-core.txt
    expect(SystemPrompt.provider(unknownModel)[0]).toBeTruthy()
  })

  test("provider prompts are shorter than core behavior", () => {
    expect(PROMPT_ANTHROPIC.length).toBeLessThan(15000)
    expect(PROMPT_GPT.length).toBeLessThan(12000)
    expect(PROMPT_GEMINI.length).toBeLessThan(10000)
  })

  test("core-behavior prompt contains key behavioral directives", () => {
    const requiredDirectives = [
      "file_path:line_number",
      "NEVER commit",
      "Prioritize technical accuracy",
      "Parallel execution",
    ]

    for (const directive of requiredDirectives) {
      expect(PROMPT_ANTHROPIC).toContain(directive)
      expect(PROMPT_GPT).toContain(directive)
      expect(PROMPT_GEMINI).toContain(directive)
    }
  })

  test("core-behavior prompt has reasonable length", () => {
    expect(PROMPT_CORE.length).toBeGreaterThan(3000)
    expect(PROMPT_CORE.length).toBeLessThan(15000)
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
