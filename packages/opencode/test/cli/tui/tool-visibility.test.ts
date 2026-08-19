import { describe, expect, test } from "bun:test"
import { shouldHideTool } from "../../../src/cli/cmd/tui/util/tool-visibility"

describe("tool visibility", () => {
  test("keeps completed exec calls visible when tool details are hidden", () => {
    expect(
      shouldHideTool({
        showDetails: false,
        tool: "exec",
        status: "completed",
        execStatus: "completed",
        toolCalls: 1,
      }),
    ).toBe(false)
  })

  test("hides completed exec calls that did not invoke any tools", () => {
    expect(
      shouldHideTool({
        showDetails: true,
        tool: "exec",
        status: "completed",
        execStatus: "completed",
        toolCalls: 0,
      }),
    ).toBe(true)
  })

  test("keeps failed exec calls visible even when they did not invoke any tools", () => {
    expect(
      shouldHideTool({
        showDetails: false,
        tool: "exec",
        status: "completed",
        execStatus: "code_error",
        toolCalls: 0,
      }),
    ).toBe(false)
  })

  test("keeps running exec calls visible before their terminal state lands", () => {
    expect(
      shouldHideTool({
        showDetails: false,
        tool: "exec",
        status: "running",
        execStatus: "completed",
        toolCalls: 0,
      }),
    ).toBe(false)
  })

  test("still hides other completed tools when tool details are hidden", () => {
    expect(shouldHideTool({ showDetails: false, tool: "bash", status: "completed" })).toBe(true)
  })

  test("keeps running and error tools visible", () => {
    expect(shouldHideTool({ showDetails: false, tool: "exec", status: "running" })).toBe(false)
    expect(shouldHideTool({ showDetails: false, tool: "bash", status: "error" })).toBe(false)
  })
})
