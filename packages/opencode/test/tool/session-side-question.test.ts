import { describe, expect, test } from "bun:test"
import { sliceSideQuestionContext } from "../../src/tool/session"

describe("sliceSideQuestionContext", () => {
  test("bounds to the most recent max messages", () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: i }))
    const out = sliceSideQuestionContext(msgs, 12)
    expect(out).toHaveLength(12)
    expect(out[0]).toEqual({ id: 88 })
    expect(out.at(-1)).toEqual({ id: 99 })
  })

  test("keeps all messages when under the cap", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ id: i }))
    expect(sliceSideQuestionContext(msgs, 12)).toHaveLength(5)
  })

  test("preserves order", () => {
    const msgs = [1, 2, 3, 4, 5]
    expect(sliceSideQuestionContext(msgs, 3)).toEqual([3, 4, 5])
  })

  test("extends the window to include a matching message when the tail has none", () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: i, role: i === 50 ? "user" : "assistant" }))
    const out = sliceSideQuestionContext(msgs, 12, (m) => m.role === "user")
    expect(out).toContainEqual({ id: 50, role: "user" })
    expect(out.at(-1)).toEqual({ id: 99, role: "assistant" })
    expect(out[0]?.id).toBeLessThanOrEqual(50)
  })

  test("stays bounded to max when the tail already contains a match", () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: i, role: i >= 90 ? "user" : "assistant" }))
    const out = sliceSideQuestionContext(msgs, 12, (m) => m.role === "user")
    expect(out).toHaveLength(12)
    expect(out.some((m) => m.role === "user")).toBe(true)
  })
})
