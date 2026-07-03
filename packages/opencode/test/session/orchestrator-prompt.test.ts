import { describe, expect, test } from "bun:test"
import PROMPT_ORCHESTRATOR from "../../src/session/prompt/orchestrator.txt"

describe("orchestrator prompt", () => {
  test("is non-empty and mentions the session tool", () => {
    expect(PROMPT_ORCHESTRATOR.length).toBeGreaterThan(0)
    expect(PROMPT_ORCHESTRATOR).toContain("`session` tool")
  })

  test("establishes a positive leader/delegator identity", () => {
    // The defining trait of this mode: it leads/coordinates and delegates the
    // work rather than doing it itself. Pin the POSITIVE identity so it can't
    // regress into a coder prompt.
    expect(PROMPT_ORCHESTRATOR).toMatch(/leader|manager|coordinat/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/delegat/i)
  })

  test("states identity positively without the 'NOT a coding agent' negation", () => {
    // T2 acceptance: the identity must be POSITIVE. The redundant negation
    // "You are NOT a coding agent" must not reappear.
    expect(PROMPT_ORCHESTRATOR).not.toContain("NOT a coding agent")
  })

  test("frames BOTH plan and review as DELEGATED jobs, not the orchestrator's own", () => {
    // T2 acceptance: planning HOW to implement and reviewing quality are jobs the
    // orchestrator DELEGATES (to plan/compose and reviewer/compose children), not
    // work it does inline. Pin that both are present and routed to children.
    expect(PROMPT_ORCHESTRATOR).toMatch(/plan/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/review/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/reviewer child|compose/i)
    // The delegation framing: these are things you delegate rather than do yourself.
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
