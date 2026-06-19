import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

const coreBehaviorPath = path.resolve(__dirname, "../../src/session/prompt/core-behavior.txt")
const coreBehavior = readFileSync(coreBehaviorPath, "utf-8")

describe("core-behavior.txt deduplication", () => {
  test("Triage Routing section appears exactly once", () => {
    const matches = coreBehavior.match(/## Triage Routing/g)
    expect(matches).toHaveLength(1)
  })

  test("Human Review Gates section appears exactly once", () => {
    const matches = coreBehavior.match(/## Human Review Gates/g)
    expect(matches).toHaveLength(1)
  })

  test("no duplicate consecutive sections", () => {
    // 检查是否有连续重复的章节标题
    const lines = coreBehavior.split("\n")
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ") && lines[i - 1] === lines[i]) {
        expect(`Duplicate section at line ${i + 1}: ${lines[i]}`).toBe("no duplicate")
      }
    }
  })
})

describe("build-switch.txt", () => {
  const buildSwitchPath = path.resolve(__dirname, "../../src/session/prompt/build-switch.txt")
  const buildSwitch = readFileSync(buildSwitchPath, "utf-8")

  test("mentions behavioral guidelines compatibility", () => {
    expect(buildSwitch).toContain("behavioral guidelines")
  })

  test("mentions plan file", () => {
    expect(buildSwitch).toContain("plan file")
  })

  test("mentions EXECUTION mode", () => {
    expect(buildSwitch).toContain("EXECUTION mode")
  })
})

describe("plan-mode.txt", () => {
  const planModePath = path.resolve(__dirname, "../../src/session/prompt/plan-mode.txt")
  const planMode = readFileSync(planModePath, "utf-8")

  test("contains PLAN_FILE_INFO placeholder", () => {
    expect(planMode).toContain("{{PLAN_FILE_INFO}}")
  })

  test("contains Plan Workflow sections", () => {
    expect(planMode).toContain("Phase 1: Initial Understanding")
    expect(planMode).toContain("Phase 2: Design")
    expect(planMode).toContain("Phase 3: Review")
    expect(planMode).toContain("Phase 4: Final Plan")
    expect(planMode).toContain("Phase 5: Call plan_exit tool")
  })

  test("mentions plan_exit tool", () => {
    expect(planMode).toContain("plan_exit")
  })
})
