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
})
