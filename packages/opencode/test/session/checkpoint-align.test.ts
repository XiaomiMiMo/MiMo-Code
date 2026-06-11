import { describe, expect, test } from "bun:test"
import { alignToNonToolResultUser } from "../../src/session/checkpoint-align"

// Minimal shape: alignToNonToolResultUser only needs `info.role` and
// `parts[].type`. Use literal objects rather than full MessageV2.WithParts
// — the helper should be schema-light.
type Msg = {
  info: { role: "user" | "assistant"; id: string }
  parts: Array<{ type: string }>
}

const u = (id: string, partTypes: string[] = ["text"]): Msg => ({
  info: { role: "user", id },
  parts: partTypes.map((t) => ({ type: t })),
})
const a = (id: string, partTypes: string[] = ["text"]): Msg => ({
  info: { role: "assistant", id },
  parts: partTypes.map((t) => ({ type: t })),
})

describe("alignToNonToolResultUser", () => {
  test("returns the input idx when it already points at a non-tool-result-only user", () => {
    const msgs = [u("u1", ["text"]), a("a1"), u("u2", ["text"])]
    expect(alignToNonToolResultUser(msgs, 2)).toBe(2)
  })

  test("walks back past assistant tool_use to the previous user", () => {
    const msgs = [u("u1"), a("a1", ["tool_use"]), u("u2", ["tool_result"]), a("a2", ["text"])]
    // idx=2 (u2 with tool_result-only parts) must back up to idx=0 (u1 plain text)
    expect(alignToNonToolResultUser(msgs, 2)).toBe(0)
  })

  test("treats user message with mixed parts (tool_result + text) as valid", () => {
    const msgs = [u("u1"), a("a1", ["tool_use"]), u("u2", ["tool_result", "text"])]
    expect(alignToNonToolResultUser(msgs, 2)).toBe(2)
  })

  test("returns 0 when no qualifying message exists in [0, idx]", () => {
    // Degenerate: only tool-result-only users + assistants
    const msgs = [u("u1", ["tool_result"]), a("a1", ["tool_use"]), u("u2", ["tool_result"])]
    expect(alignToNonToolResultUser(msgs, 2)).toBe(0)
  })

  test("returns idx itself when idx is past the end (empty delta intent)", () => {
    const msgs = [u("u1"), a("a1")]
    expect(alignToNonToolResultUser(msgs, 2)).toBe(2)
  })

  test("idx 0 with valid first message returns 0", () => {
    const msgs = [u("u1")]
    expect(alignToNonToolResultUser(msgs, 0)).toBe(0)
  })

  test("treats user with empty parts as valid (cannot be orphan tool_result)", () => {
    const msgs: Msg[] = [u("u1", ["tool_result"]), a("a1", ["tool_use"]), { info: { role: "user", id: "u2" }, parts: [] }]
    expect(alignToNonToolResultUser(msgs, 2)).toBe(2)
  })
})
