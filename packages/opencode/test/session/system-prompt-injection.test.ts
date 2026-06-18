import { describe, expect, test } from "bun:test"
import PROMPT_ANTHROPIC from "../../src/session/prompt/anthropic.txt"
import PROMPT_DEFAULT from "../../src/session/prompt/default.txt"
import BUILD_SWITCH from "../../src/session/prompt/build-switch.txt"
import MAX_STEPS from "../../src/session/prompt/max-steps.txt"
import { RECOVERY_PROMPT_MILD, RECOVERY_PROMPT_STRONG } from "../../src/session/prompt/text-loop-recovery"

// 模拟 Provider.Model 类型
function mockModel(apiId: string, providerID = "anthropic") {
  return {
    id: apiId,
    api: { id: apiId, npm: "@ai-sdk/anthropic" },
    providerID,
    capabilities: {
      reasoning: true,
      temperature: false,
      input: { image: true, audio: false, video: false, pdf: false },
    },
    limit: { output: 128000 },
  } as any
}

describe("System Prompt 注入验证", () => {
  test("Claude 模型应加载 anthropic.txt 而非 default.txt", () => {
    // 模拟 system.ts provider() 函数的逻辑
    const model = mockModel("claude-sonnet-4-20250514")
    const prompt = model.api.id.includes("claude") ? PROMPT_ANTHROPIC : PROMPT_DEFAULT

    expect(prompt).toBe(PROMPT_ANTHROPIC)
    expect(prompt).not.toBe(PROMPT_DEFAULT)
  })

  test("非 Claude 模型应加载 default.txt", () => {
    const model = mockModel("gpt-4o", "openai")
    model.api.npm = "@ai-sdk/openai"
    const prompt = model.api.id.includes("claude")
      ? PROMPT_ANTHROPIC
      : PROMPT_DEFAULT

    expect(prompt).toBe(PROMPT_DEFAULT)
  })

  test("anthropic.txt 包含所有 Claude Code 风格行为指令", () => {
    const requiredDirectives = [
      // 核心行为指令
      "Thinking & Analysis Rules",
      "Professional objectivity",
      "Output Style",
      "Task Management",
      "Code Quality",
      "Tool Usage Strategy",
      "Executing Actions with Care",
      "Git Safety",
      // 关键行为规则
      "Read at least 3 existing implementations",
      "Parallel execution",
      "file_path:line_number",
      "Do NOT add comments unless explicitly asked",
      "NEVER commit changes unless the user explicitly asks",
      "Prioritize technical accuracy over validating",
    ]

    for (const directive of requiredDirectives) {
      expect(PROMPT_ANTHROPIC).toContain(directive)
    }
  })

  test("default.txt 包含所有 Claude Code 风格行为指令", () => {
    const requiredDirectives = [
      "Thinking & Analysis Rules",
      "Professional objectivity",
      "Tool Usage Strategy",
      "Executing Actions with Care",
      "Git Safety",
      "Read at least 3 existing implementations",
      "Parallel execution",
    ]

    for (const directive of requiredDirectives) {
      expect(PROMPT_DEFAULT).toContain(directive)
    }
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

describe("prompt 文件完整性", () => {
  test("anthropic.txt 长度合理（非空、非过长）", () => {
    expect(PROMPT_ANTHROPIC.length).toBeGreaterThan(5000)
    expect(PROMPT_ANTHROPIC.length).toBeLessThan(15000)
  })

  test("default.txt 长度合理", () => {
    expect(PROMPT_DEFAULT.length).toBeGreaterThan(5000)
    expect(PROMPT_DEFAULT.length).toBeLessThan(15000)
  })

  test("anthropic.txt 包含模型 ID 占位符", () => {
    // anthropic.txt 应该有 ${model.api.id} 占位符（被 system.ts 替换）
    expect(PROMPT_ANTHROPIC).toContain("${model.api.id}")
    expect(PROMPT_ANTHROPIC).toContain("${model.providerID}")
  })
})
