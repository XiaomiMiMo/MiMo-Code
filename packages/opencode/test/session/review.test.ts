import { describe, expect, test } from "bun:test"
import { ReviewGate } from "../../src/session/review"

describe("ReviewGate.decide", () => {
  const base = {
    isMain: true,
    autoEnabled: true,
    inFlight: false,
    count: 0,
    maxRounds: 3,
    sessionHasTasks: false,
    allTasksTerminal: true,
    hasUncommittedChanges: true,
    diffHash: "h1",
    lastReviewedHash: undefined,
  }

  test("fires when main, enabled, diff present, and not yet reviewed", () => {
    expect(ReviewGate.decide(base)).toEqual({ needReentry: true })
  })

  test("skips when not the main agent", () => {
    expect(ReviewGate.decide({ ...base, isMain: false })).toEqual({ needReentry: false, reason: "not-main" })
  })

  test("skips when disabled", () => {
    expect(ReviewGate.decide({ ...base, autoEnabled: false })).toEqual({ needReentry: false, reason: "disabled" })
  })

  test("skips when a review is already in flight", () => {
    expect(ReviewGate.decide({ ...base, inFlight: true })).toEqual({ needReentry: false, reason: "in-flight" })
  })

  test("skips when no uncommitted changes", () => {
    expect(ReviewGate.decide({ ...base, hasUncommittedChanges: false })).toEqual({
      needReentry: false,
      reason: "no-diff",
    })
  })

  test("skips when tasks exist but are not all terminal (task-mode)", () => {
    expect(ReviewGate.decide({ ...base, sessionHasTasks: true, allTasksTerminal: false })).toEqual({
      needReentry: false,
      reason: "tasks-open",
    })
  })

  test("fires in task-mode when all tasks are terminal", () => {
    expect(ReviewGate.decide({ ...base, sessionHasTasks: true, allTasksTerminal: true })).toEqual({
      needReentry: true,
    })
  })

  test("dedup: skips when the diff was already reviewed", () => {
    expect(ReviewGate.decide({ ...base, lastReviewedHash: "h1" })).toEqual({ needReentry: false, reason: "dedup" })
  })

  test("cap: skips when round count reached the max", () => {
    expect(ReviewGate.decide({ ...base, count: 3, maxRounds: 3 })).toEqual({ needReentry: false, reason: "cap" })
  })

  test("fires below the cap", () => {
    expect(ReviewGate.decide({ ...base, count: 2, maxRounds: 3 })).toEqual({ needReentry: true })
  })
})

describe("ReviewGate.hashDiff", () => {
  test("same input produces same hash, different input different hash", () => {
    const a = ReviewGate.hashDiff("unchanged content")
    const b = ReviewGate.hashDiff("unchanged content")
    const c = ReviewGate.hashDiff("changed content")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe("ReviewGate.extractFindings", () => {
  test("returns [] for non-success outcomes", () => {
    expect(ReviewGate.extractFindings({ status: "failure", error: "boom" })).toEqual([])
    expect(ReviewGate.extractFindings({ status: "cancelled" })).toEqual([])
  })

  test("returns [] when structured is missing or malformed", () => {
    expect(ReviewGate.extractFindings({ status: "success" })).toEqual([])
    expect(ReviewGate.extractFindings({ status: "success", structured: { nope: 1 } })).toEqual([])
  })

  test("returns the findings array", () => {
    const findings: ReviewGate.Finding[] = [{ file: "a.ts", severity: "high", title: "bug", detail: "detail" }]
    expect(ReviewGate.extractFindings({ status: "success", structured: { findings } })).toEqual(findings)
  })

  test("drops malformed findings (missing or invalid severity)", () => {
    const structured = {
      findings: [
        { file: "a.ts", severity: "high", title: "bug", detail: "detail" },
        { file: "b.ts", title: "missing severity", detail: "x" },
        { file: "c.ts", severity: "critical", title: "bad severity", detail: "x" },
      ],
    }
    expect(ReviewGate.extractFindings({ status: "success", structured })).toEqual([
      { file: "a.ts", severity: "high", title: "bug", detail: "detail" },
    ])
  })
})

describe("ReviewGate.findingsText", () => {
  test("renders findings as a system-reminder with severity, file, line, and fix", () => {
    const text = ReviewGate.findingsText([
      { file: "a.ts", line: 3, severity: "high", title: "null deref", detail: "crashes on null", fix_suggestion: "guard it" },
      { file: "b.ts", severity: "low", title: "naming", detail: "confusing", fix_suggestion: "rename" },
    ])
    expect(text).toContain("<system-reminder>")
    expect(text).toContain("**HIGH** `a.ts:3`: null deref")
    expect(text).toContain("**LOW** `b.ts`: naming")
    expect(text).toContain("Fix: guard it")
    expect(text).toContain("independent reviewer found issues")
  })

  test("empty findings produces a generic message", () => {
    const text = ReviewGate.findingsText([])
    expect(text).toContain("<system-reminder>")
    expect(text).toContain("independent reviewer")
  })
})
