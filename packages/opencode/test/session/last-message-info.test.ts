import { describe, test, expect } from "bun:test"
import { computeLastMessageInfo } from "../../src/session/last-message-info"

describe("computeLastMessageInfo", () => {
  test("assistant with finish=tool-calls", () => {
    const msgs = [{ role: "assistant", finish: "tool-calls" }]
    expect(computeLastMessageInfo(msgs)).toEqual({ role: "assistant", finish: "tool-calls" })
  })

  test("assistant with finish=stop", () => {
    const msgs = [{ role: "assistant", finish: "stop" }]
    expect(computeLastMessageInfo(msgs)).toEqual({ role: "assistant", finish: "stop" })
  })

  test("assistant with no finish defaults to stop", () => {
    const msgs = [{ role: "assistant" }]
    expect(computeLastMessageInfo(msgs)).toEqual({ role: "assistant", finish: "stop" })
  })

  test("assistant with unknown finish defaults to stop", () => {
    const msgs = [{ role: "assistant", finish: "unknown" }]
    expect(computeLastMessageInfo(msgs)).toEqual({ role: "assistant", finish: "stop" })
  })

  test("tool result at tail", () => {
    const msgs = [{ role: "tool" }]
    expect(computeLastMessageInfo(msgs)).toEqual({ role: "tool" })
  })

  test("user message at tail", () => {
    const msgs = [{ role: "user" }]
    expect(computeLastMessageInfo(msgs)).toEqual({ role: "user" })
  })

  test("only inspects last message", () => {
    const msgs = [
      { role: "user" },
      { role: "assistant", finish: "stop" },
      { role: "user" },
    ]
    expect(computeLastMessageInfo(msgs)).toEqual({ role: "user" })
  })

  test("empty array returns undefined", () => {
    expect(computeLastMessageInfo([])).toBeUndefined()
  })
})
