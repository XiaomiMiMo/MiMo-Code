import { describe, expect, test } from "bun:test"
import { pruneToolOutputs, PRUNE_PROTECT, PRUNE_PROTECTED_TOOLS } from "../../src/session/compaction"
import { MessageID } from "../../src/session/schema"

function toolPart(tool: string, output: string, completed = true) {
  return {
    type: "tool",
    tool,
    state: { status: completed ? "completed" : "pending", input: {}, output, time: { start: 0, end: 0 } },
  } as any
}

function userMsg(text: string) {
  return { info: { id: MessageID.ascending(), role: "user" }, parts: [{ type: "text", text }] } as any
}

function assistantMsg(parts: any[], summary = false) {
  return { info: { id: MessageID.ascending(), role: "assistant", summary }, parts } as any
}

describe("pruneToolOutputs", () => {
  test("strips old completed tool outputs past PRUNE_PROTECT", () => {
    // est = len/4 => ~50K tokens, past the 40K protect budget.
    const big = "x".repeat(PRUNE_PROTECT * 5)
    // The read output sits more than the protected 2 turns back, so it's
    // eligible for stripping; the edit output is inside the protected window.
    const msgs = [
      userMsg("first"),
      assistantMsg([toolPart("read", big)]),   // large old output
      userMsg("second"),
      assistantMsg([toolPart("edit", "small")]),
      userMsg("third"),
    ]
    pruneToolOutputs(msgs)
    const toolParts = msgs.flatMap((m: any) => m.parts).filter((p: any) => p.type === "tool")
    // The large old output (before the protected 2 turns) must be stripped.
    expect(toolParts[0].state.output).toBe("")
    // Recent turn (within protection) keeps its output.
    expect(toolParts[1].state.output).toBe("small")
  })

  test("keeps protected tools' outputs", () => {
    const big = "x".repeat(PRUNE_PROTECT * 5)
    // The skill output is old enough to be stripped, but skill is protected.
    const msgs = [
      userMsg("first"),
      assistantMsg([toolPart(PRUNE_PROTECTED_TOOLS[0], big)]),  // protected tool
      userMsg("second"),
      userMsg("third"),
    ]
    pruneToolOutputs(msgs)
    const toolParts = msgs.flatMap((m: any) => m.parts).filter((p: any) => p.type === "tool")
    expect(toolParts[0].state.output).toBe(big)  // not stripped
  })

  test("leaves small sessions untouched", () => {
    const msgs = [
      userMsg("hi"),
      assistantMsg([toolPart("read", "tiny")]),
      userMsg("bye"),
    ]
    pruneToolOutputs(msgs)
    const toolParts = msgs.flatMap((m: any) => m.parts).filter((p: any) => p.type === "tool")
    expect(toolParts[0].state.output).toBe("tiny")
  })

  test("stops the walk at a summary message, leaving pre-summary parts untouched", () => {
    const big = "x".repeat(PRUNE_PROTECT * 5)
    const msgs = [
      userMsg("old"),
      assistantMsg([toolPart("read", big)]),                      // pre-summary, would be stripped if reached
      assistantMsg([{ type: "text", text: "summarized" }], true), // summary boundary
      userMsg("mid"),
      assistantMsg([toolPart("grep", big)]),                       // post-summary, outside the protected tail
      userMsg("recent"),
      assistantMsg([toolPart("edit", "small")]),                   // recent tail, protected
      userMsg("last"),
    ]
    pruneToolOutputs(msgs)
    const toolParts = msgs.flatMap((m: any) => m.parts).filter((p: any) => p.type === "tool")
    // The walk broke at the summary, so the pre-summary read output is untouched.
    expect(toolParts[0].state.output).toBe(big)
    // The post-summary grep output is old enough to be stripped.
    expect(toolParts[1].state.output).toBe("")
    // The recent tail keeps its output.
    expect(toolParts[2].state.output).toBe("small")
  })
})
