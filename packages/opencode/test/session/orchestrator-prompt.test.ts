import { describe, expect, test } from "bun:test"
import PROMPT_ORCHESTRATOR from "../../src/session/prompt/orchestrator.txt"

describe("orchestrator prompt", () => {
  test("is non-empty and mentions the session tool", () => {
    expect(PROMPT_ORCHESTRATOR.length).toBeGreaterThan(0)
    expect(PROMPT_ORCHESTRATOR).toContain("`session` tool")
  })

  test("establishes a delegator identity, not a coding agent", () => {
    // The defining trait of this mode: it coordinates/delegates rather than
    // doing the work itself. Pin so it can't regress into a coder prompt.
    expect(PROMPT_ORCHESTRATOR).toContain("NOT a coding agent")
    expect(PROMPT_ORCHESTRATOR).toMatch(/delegat/i)
  })

  test("teaches the per-task dir/isolate model (S13)", () => {
    // Pin the S13 guidance so it can't be silently dropped: the prompt must tell
    // the orchestrator about choosing a child's directory and isolation per task.
    expect(PROMPT_ORCHESTRATOR).toContain("dir")
    expect(PROMPT_ORCHESTRATOR).toContain("isolate")
  })

  test("teaches no-poll + interrupt/resume lifecycle (session-lifecycle spec)", () => {
    // Pin so the lifecycle guidance can't be silently dropped.
    expect(PROMPT_ORCHESTRATOR).toContain("don't poll")
    expect(PROMPT_ORCHESTRATOR).toContain("session cancel")
    expect(PROMPT_ORCHESTRATOR).toContain("resume")
  })
})
