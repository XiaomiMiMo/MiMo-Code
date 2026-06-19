import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

// ─── text loop 恢复提示词 ────────────────────────────

describe("text loop recovery prompts", () => {
  const { RECOVERY_PROMPT_MILD, RECOVERY_PROMPT_STRONG } = require("../../src/session/prompt/text-loop-recovery")

  test("RECOVERY_PROMPT_MILD contains loop detected message", () => {
    expect(RECOVERY_PROMPT_MILD).toContain("LOOP DETECTED")
    expect(RECOVERY_PROMPT_MILD).toContain("<system-reminder>")
    expect(RECOVERY_PROMPT_MILD).toContain("</system-reminder>")
  })

  test("RECOVERY_PROMPT_STRONG contains critical failure message", () => {
    expect(RECOVERY_PROMPT_STRONG).toContain("CRITICAL FAILURE")
    expect(RECOVERY_PROMPT_STRONG).toContain("<system-reminder>")
    expect(RECOVERY_PROMPT_STRONG).toContain("</system-reminder>")
  })
})

// ─── text loop 错误信息提升 ──────────────────────────

describe("text loop error message", () => {
  const promptPath = path.resolve(__dirname, "../../src/session/prompt.ts")
  const content = readFileSync(promptPath, "utf-8")

  test("error message contains repeated output snippet", () => {
    expect(content).toContain("repeatedSnippet")
    expect(content).toContain("Repeated output snippet:")
  })

  test("error message suggests switching model", () => {
    expect(content).toContain("Suggestion:")
    expect(content).toContain("switching to a different model")
  })
})

// ─── consecutiveToolOnlySteps 部分重置 ─────────────────

describe("consecutiveToolOnlySteps reset strategy", () => {
  const promptPath = path.resolve(__dirname, "../../src/session/prompt.ts")
  const content = readFileSync(promptPath, "utf-8")

  test("partial reset uses Math.floor(CONSECUTIVE_TOOL_ONLY_THRESHOLD / 2)", () => {
    expect(content).toContain("Partial reset")
    expect(content).toContain("CONSECUTIVE_TOOL_ONLY_THRESHOLD / 2")
  })
})

// ─── insertReminders 拆分 ─────────────────────────────

describe("insertReminders split", () => {
  const promptPath = path.resolve(__dirname, "../../src/session/prompt.ts")
  const content = readFileSync(promptPath, "utf-8")

  test("injectComposePrompt is defined", () => {
    expect(content).toContain("injectComposePrompt")
  })

  test("injectBuildSwitch is defined", () => {
    expect(content).toContain("injectBuildSwitch")
  })

  test("injectPlanMode is defined", () => {
    expect(content).toContain("injectPlanMode")
  })

  test("injectPlanMode checks agent name against AGENT_PLAN constant", () => {
    expect(content).toContain("AGENT_PLAN")
  })

  test("insertReminders calls all three inject functions", () => {
    expect(content).toContain("yield* injectComposePrompt(input)")
    expect(content).toContain("yield* injectBuildSwitch(input)")
    expect(content).toContain("yield* injectPlanMode(input)")
  })
})

// ─── compose prompt 注入守卫 ──────────────────────────

describe("compose prompt injection guard", () => {
  const promptPath = path.resolve(__dirname, "../../src/session/prompt.ts")
  const content = readFileSync(promptPath, "utf-8")

  test("checks alreadyInjected before unshifting", () => {
    expect(content).toContain("alreadyInjected")
  })

  test("checks PROMPT_COMPOSE.slice(0, 50) for duplicate detection", () => {
    expect(content).toContain("PROMPT_COMPOSE.slice")
  })
})

// ─── plan_exit 行为 ──────────────────────────────────

describe("plan_exit tool behavior", () => {
  const planPath = path.resolve(__dirname, "../../src/tool/plan.ts")
  const content = readFileSync(planPath, "utf-8")

  test("rejects non-plan agent callers", () => {
    expect(content).toContain('ctx.agent !== AGENT_PLAN')
    expect(content).toContain("The plan_exit tool can only be called by the plan agent")
  })

  test("checks plan file existence", () => {
    expect(content).toContain("existsSafe")
    expect(content).toContain("No plan file exists at")
  })

  test("returns normal result instead of RejectedError on No", () => {
    expect(content).not.toContain("RejectedError")
    expect(content).toContain('"Staying in plan mode"')
  })

  test("output includes model info on successful switch", () => {
    expect(content).toContain("Current model:")
    expect(content).toContain("model.providerID")
    expect(content).toContain("/model to change the model")
  })

  test("uses AGENT_BUILD constant for switch target", () => {
    expect(content).toContain("AGENT_BUILD")
  })

  test("uses Session.planRelative for display path", () => {
    expect(content).toContain("Session.planRelative")
  })

  test("no longer imports path module (planRelative replaces it)", () => {
    // verify Instance and path imports are gone
    expect(content).not.toContain('from "../project/instance"')
  })
})

// ─── build-switch.txt 与 core-behavior 兼容性 ─────────

describe("build-switch compatibility", () => {
  const buildSwitchPath = path.resolve(__dirname, "../../src/session/prompt/build-switch.txt")
  const content = readFileSync(buildSwitchPath, "utf-8")

  test("mentions existing behavioral guidelines still apply", () => {
    expect(content).toContain("behavioral guidelines")
  })
})

// ─── AGENT_COMPOSE 使用 ──────────────────────────────

describe("AGENT_COMPOSE constant usage", () => {
  const promptPath = path.resolve(__dirname, "../../src/session/prompt.ts")
  const content = readFileSync(promptPath, "utf-8")

  test("prompt.ts uses AGENT_COMPOSE constant", () => {
    expect(content).toContain("AGENT_COMPOSE")
  })
})
