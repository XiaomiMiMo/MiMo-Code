import { describe, expect, test } from "bun:test"
import PROMPT_CORE_BEHAVIOR from "../../src/session/prompt/core-behavior.txt"
import BUILD_SWITCH from "../../src/session/prompt/build-switch.txt"
import MAX_STEPS from "../../src/session/prompt/max-steps.txt"
import { RECOVERY_PROMPT_MILD, RECOVERY_PROMPT_STRONG } from "../../src/session/prompt/text-loop-recovery"
import { SystemPrompt } from "../../src/session/system"

describe("核心行为 prompt 注入验证", () => {
  test("所有模型使用同一个核心行为 prompt", () => {
    // 无论什么模型，都应该返回同一个 prompt
    const claudeModel = { api: { id: "claude-sonnet-4-20250514" } } as any
    const gptModel = { api: { id: "gpt-4o" } } as any
    const geminiModel = { api: { id: "gemini-2.5-pro" } } as any

    expect(SystemPrompt.provider(claudeModel)).toEqual([PROMPT_CORE_BEHAVIOR])
    expect(SystemPrompt.provider(gptModel)).toEqual([PROMPT_CORE_BEHAVIOR])
    expect(SystemPrompt.provider(geminiModel)).toEqual([PROMPT_CORE_BEHAVIOR])
  })

  test("核心行为 prompt 包含所有 MiMoCode 专属行为指令", () => {
    const requiredDirectives = [
      // MiMoCode 核心特性
      "Actor 委派",
      "Task 工具",
      "Memory 系统",
      "Skill 系统",
      "Plan 模式",
      "验证闭环",
      // 通用行为指令
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

  test("核心行为 prompt 长度合理", () => {
    expect(PROMPT_CORE_BEHAVIOR.length).toBeGreaterThan(5000)
    expect(PROMPT_CORE_BEHAVIOR.length).toBeLessThan(15000)
  })
})

describe("运行时 system-reminder 注入验证", () => {
  test("build-switch.txt 包含执行模式指令", () => {
    expect(BUILD_SWITCH).toContain("EXECUTION mode")
    expect(BUILD_SWITCH).toContain("What you MUST do")
    expect(BUILD_SWITCH).toContain("What you MUST NOT do")
  })

  test("max-steps.txt 包含结构化响应要求", () => {
    expect(MAX_STEPS).toContain("MAXIMUM STEPS")
    expect(MAX_STEPS).toContain("text ONLY")
    expect(MAX_STEPS).toContain("summary of what was accomplished")
  })

  test("RECOVERY_PROMPT_MILD 包含循环检测指令", () => {
    expect(RECOVERY_PROMPT_MILD).toContain("LOOP DETECTED")
    expect(RECOVERY_PROMPT_MILD).toContain("STOP immediately")
    expect(RECOVERY_PROMPT_MILD).toContain("Re-read the original user request")
  })

  test("RECOVERY_PROMPT_STRONG 包含严重循环指令", () => {
    expect(RECOVERY_PROMPT_STRONG).toContain("CRITICAL FAILURE")
    expect(RECOVERY_PROMPT_STRONG).toContain("ABANDON your current plan")
    expect(RECOVERY_PROMPT_STRONG).toContain("Propose 2-3 alternative approaches")
  })
})
