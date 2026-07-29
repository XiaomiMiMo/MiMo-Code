import { describe, expect, test } from "bun:test"
import { Command, workflowTemplate } from "../../src/command"

describe("/workflow command", () => {
  test("Default has the workflow name", () => {
    expect(Command.Default.WORKFLOW).toBe("workflow")
  })

  test("template asks the primary agent to generate and run a customizable JavaScript DAG", () => {
    const template = workflowTemplate()
    expect(template).toContain("$ARGUMENTS")
    expect(template).toContain("dag(nodes")
    expect(template).toContain("agentType")
    expect(template).toContain("prompt")
    expect(template).toContain("model")
    expect(template).toContain("dependsOn")
    expect(template).toContain('operation: "run"')
    expect(template).toContain("script")
  })

  test("template requires an independent verifier and bounded rework", () => {
    const template = workflowTemplate()
    expect(template).toContain("independent verifier")
    expect(template).toContain("verifier/reviewer agentType")
    expect(template).toContain("at least as capable")
    expect(template).toContain("default 2")
    expect(template).toContain("hard maximum 3")
    expect(template).toContain("accepted")
    expect(template).toContain("evidence")
  })

  test("template supports optional JSON customization without requiring it", () => {
    const template = workflowTemplate()
    expect(template).toContain("optional JSON")
    expect(template).toContain("natural-language task")
  })
})
