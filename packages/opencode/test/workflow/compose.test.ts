import { describe, expect, test } from "bun:test"
import { BuiltinWorkflow } from "../../src/workflow/builtin"
import { parseMeta } from "../../src/workflow/meta"
import { evalScript } from "../../src/workflow/sandbox"

const composeScript = () => {
  const c = BuiltinWorkflow.get("compose")
  expect(c).toBeDefined()
  return c!.script
}

describe("compose script structure", () => {
  test("body parses cleanly", () => {
    const parsed = parseMeta(composeScript())
    expect(parsed.ok).toBe(true)
  })

  test("declares schemas for every phase", () => {
    const script = composeScript()
    expect(script).toContain("CLASSIFY_SHAPE")
    expect(script).toContain("DESIGN_SHAPE")
    expect(script).toContain("VERIFY_SHAPE")
    expect(script).toContain("REVIEW_SHAPE")
    expect(script).toContain("MERGE_SHAPE")
  })
})
