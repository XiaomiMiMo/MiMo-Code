import { describe, expect, test } from "bun:test"
import { adjustBoundaryForApiInvariants } from "../../src/session/boundary"

type Msg = { role: "user" | "assistant" | "tool"; content: any[]; id?: string }

describe("adjustBoundaryForApiInvariants", () => {
  test("walks back to include tool_use when tool_result is in tail", () => {
    const msgs: Msg[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "X", name: "read" }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "X", text: "result" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]
    // Candidate boundary at idx=2 (tail starts with tool_result)
    // Should walk back to idx=1 (include the tool_use)
    expect(adjustBoundaryForApiInvariants(msgs, 2)).toBe(1)
  })

  test("returns boundary unchanged when no orphans", () => {
    const msgs: Msg[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hi back" }] },
      { role: "user", content: [{ type: "text", text: "more" }] },
    ]
    expect(adjustBoundaryForApiInvariants(msgs, 2)).toBe(2)
  })

  test("returns boundary unchanged when 0 or full length", () => {
    const msgs: Msg[] = [{ role: "user", content: [] }]
    expect(adjustBoundaryForApiInvariants(msgs, 0)).toBe(0)
    expect(adjustBoundaryForApiInvariants(msgs, 1)).toBe(1)
  })
})
