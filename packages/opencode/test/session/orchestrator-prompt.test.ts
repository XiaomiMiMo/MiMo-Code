import { describe, expect, test } from "bun:test"
import PROMPT_ORCHESTRATOR from "../../src/session/prompt/orchestrator.txt"

describe("orchestrator prompt", () => {
  test("is non-empty and mentions the session tool", () => {
    expect(PROMPT_ORCHESTRATOR.length).toBeGreaterThan(0)
    expect(PROMPT_ORCHESTRATOR).toContain("`session` tool")
  })
})
