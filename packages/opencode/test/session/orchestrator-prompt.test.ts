import { describe, expect, test } from "bun:test"
import PROMPT_ORCHESTRATOR from "../../src/session/prompt/orchestrator.txt"

describe("orchestrator prompt", () => {
  test("is non-empty and mentions the session tool", () => {
    expect(PROMPT_ORCHESTRATOR.length).toBeGreaterThan(0)
    expect(PROMPT_ORCHESTRATOR).toContain("`session` tool")
  })

  test("teaches the per-task dir/isolate model (S13)", () => {
    // Pin the S13 guidance so it can't be silently dropped: the prompt must tell
    // the orchestrator about choosing a child's directory and isolation per task.
    expect(PROMPT_ORCHESTRATOR).toContain("dir")
    expect(PROMPT_ORCHESTRATOR).toContain("isolate")
  })
})
