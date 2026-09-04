import { describe, expect, test } from "bun:test"
import { capSummaryDiffs, MAX_SUMMARY_DIFF_BYTES } from "../../src/session/summary"

describe("capSummaryDiffs", () => {
  test("caps a single huge patch to the budget", () => {
    const huge = "x".repeat(MAX_SUMMARY_DIFF_BYTES * 2)
    const out = capSummaryDiffs([{ file: "a.json", patch: huge, additions: 1, deletions: 1, status: "modified" as const }])
    expect(out).toHaveLength(1)
    expect(out[0].patch.length).toBeLessThanOrEqual(MAX_SUMMARY_DIFF_BYTES)
    expect(out[0].patch.startsWith("x")).toBe(true)
  })

  test("keeps small diffs unchanged", () => {
    const small = [{ file: "a.ts", patch: "diff --git a/a.ts", additions: 1, deletions: 1, status: "modified" as const }]
    expect(capSummaryDiffs(small)).toEqual(small)
  })

  test("drops entries once the budget is exhausted", () => {
    const big = "y".repeat(MAX_SUMMARY_DIFF_BYTES)
    const out = capSummaryDiffs([
      { file: "a", patch: big, additions: 1, deletions: 1 },
      { file: "b", patch: big, additions: 1, deletions: 1 },
    ])
    expect(out.length).toBe(1)
  })
})
