import { describe, expect, test } from "bun:test"
import { shouldHideTool } from "../../../src/cli/cmd/tui/util/tool-visibility"

describe("tool visibility", () => {
  test("keeps completed exec calls visible when tool details are hidden", () => {
    expect(shouldHideTool({ showDetails: false, tool: "exec", status: "completed" })).toBe(false)
  })

  test("still hides other completed tools when tool details are hidden", () => {
    expect(shouldHideTool({ showDetails: false, tool: "bash", status: "completed" })).toBe(true)
  })

  test("keeps running and error tools visible", () => {
    expect(shouldHideTool({ showDetails: false, tool: "exec", status: "running" })).toBe(false)
    expect(shouldHideTool({ showDetails: false, tool: "bash", status: "error" })).toBe(false)
  })
})
