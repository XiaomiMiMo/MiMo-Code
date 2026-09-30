import { describe, expect, test } from "bun:test"
import { renderWorkflowCatalog } from "../../src/tool/registry"

describe("workflow catalog description", () => {
  test("lists deep-research with its whenToUse", () => {
    const text = renderWorkflowCatalog()
    expect(text).toContain("deep-research")
    expect(text).toContain("Deep research")
    expect(text).toContain("multi-source")
    expect(text).toContain('name: "deep-research"')
  })
})
