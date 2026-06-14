import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import type { MessageID, SessionID } from "../../src/session/schema"
import { computeBoundary } from "../../src/session/checkpoint"

const SID = "s_test" as SessionID

function userMsg(id: string, time: number, parts?: Array<{ type: string; text?: string; [k: string]: unknown }>): MessageV2.WithParts {
  return {
    info: {
      id: id as MessageID,
      sessionID: SID,
      role: "user",
      time: { created: time },
      agent: "build",
      model: { providerID: "anthropic" as never, modelID: "claude" as never },
    } as MessageV2.User,
    parts: parts ?? [],
  } as unknown as MessageV2.WithParts
}

function asstMsg(id: string, time: number, finish?: string, parts?: Array<{ type: string; text?: string; [k: string]: unknown }>): MessageV2.WithParts {
  return {
    info: {
      id: id as MessageID,
      sessionID: SID,
      role: "assistant",
      time: { created: time },
      agent: "build",
      providerID: "anthropic" as never,
      modelID: "claude" as never,
      mode: "build",
      variant: "default" as never,
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(finish ? { finish } : {}),
    } as unknown as MessageV2.Assistant,
    parts: parts ?? [],
  } as unknown as MessageV2.WithParts
}

// Helper: build a chunk of text parts whose stringified size sums to ~target tokens.
// Token.estimate is roughly chars/4. Multiply by 4 to size the text payload.
function textParts(targetTokens: number): Array<{ type: string; text: string }> {
  const charCount = Math.max(100, targetTokens * 4)
  return [{ type: "text", text: "x".repeat(charCount) }]
}

// Helper: build a chunk of "tool" parts whose stringified size sums to ~target tokens.
function toolParts(targetTokens: number): Array<{ type: string; tool: string; payload: string }> {
  const charCount = Math.max(100, targetTokens * 4)
  return [{ type: "tool", tool: "read", payload: "x".repeat(charCount) }]
}

describe("computeBoundary", () => {
  test("normal user → asst: small tail expands backward to meet floors", () => {
    // u0 + a1, both empty parts = ~0 tokens, 1 text block (a1 has no text parts so 0).
    // Should expand backward but stops at u0 (no earlier messages).
    const msgs = [userMsg("u0", 0), asstMsg("a1", 10, "stop")]
    const result = computeBoundary(msgs)
    // With empty parts, tail is tiny and will try to expand. Result depends on token estimation.
    expect(["u0"]).toContain(result)
  })

  test("tool-call loop with sufficient tokens stays in reasonable range", () => {
    // All empty parts, so total tokens ~0. Should expand backward to meet floors.
    const msgs = [
      userMsg("u0", 0),
      asstMsg("a1", 10, "stop"),
      asstMsg("a2", 20, "stop"),
      asstMsg("a3", 30, "stop"),
    ]
    const result = computeBoundary(msgs)
    // Without tokens, expands backward; result is in early range.
    expect(["u0", "a1"]).toContain(result)
  })

  test("only one finished asst at the start: returns that asst (degenerate but doesn't crash)", () => {
    const msgs = [asstMsg("a1", 10, "stop")]
    expect(computeBoundary(msgs)).toBe("a1")
  })

  test("trailing asst without finish is skipped — boundary set by prior finished turn", () => {
    const msgs = [
      userMsg("u0", 0),
      asstMsg("a1", 10, "stop"),
      asstMsg("a2_pending", 20, undefined),
    ]
    const result = computeBoundary(msgs)
    // lastAsstIdx = 1 (a1), startIdx = 0 (u0). Tail = u0 + a1, empty parts.
    // Expands backward but stops at u0.
    expect(["u0"]).toContain(result)
  })

  test("no finished asst (degenerate): falls back to msgs[0]", () => {
    const msgs = [userMsg("u0", 0)]
    expect(computeBoundary(msgs)).toBe("u0")
  })

  test("0 messages returns empty", () => {
    expect(computeBoundary([])).toBe("")
  })

  test("small tail expands backward to hit minTokens floor", () => {
    // Build: u1(~2K), a1(~2K), u2(~2K), a2(~2K), u3(~100), a3(~100, finished)
    // lastAsstIdx = 5, startIdx = 4 (u3). Tail = u3 + a3 = ~200 tokens.
    // Below minTokens(10K), so walk backward to include a2, u2, a1, u1.
    // Expected: walk back until >= 10K tokens AND >= 5 text blocks.
    const msgs = [
      userMsg("u1", 0, textParts(2000)),
      asstMsg("a1", 10, "stop", textParts(2000)),
      userMsg("u2", 20, textParts(2000)),
      asstMsg("a2", 30, "stop", textParts(2000)),
      userMsg("u3", 40, textParts(100)),
      asstMsg("a3", 50, "stop", textParts(100)),
    ]
    const result = computeBoundary(msgs)
    // Should expand back to include earlier messages (a1 or u1 or both).
    expect(["u1", "a1"]).toContain(result)
  })

  test("huge natural tail stays put (soft ceiling — no forward contraction)", () => {
    // Build: u1(~1K), a1(~1K), u2(~1K), a2(~55K, finished)
    // lastAsstIdx = 3, startIdx = 2 (u2). Tail = u2 + a2 = ~56K.
    // >= maxTokens(20K), so leave boundary as-is and return.
    // Forward contraction would split tool_use/tool_result pairs and
    // adjustBoundaryForApiInvariants would just walk back — net no-op.
    // Expected: boundary stays at u2.
    const msgs = [
      userMsg("u1", 0, textParts(1000)),
      asstMsg("a1", 10, "stop", textParts(1000)),
      userMsg("u2", 20, textParts(1000)),
      asstMsg("a2", 30, "stop", toolParts(55000)),
    ]
    const result = computeBoundary(msgs)
    expect(result).toBe("u2")
  })

  test("goldilocks range (10K–40K with 5+ text blocks): boundary stays in reasonable range", () => {
    // Build: u1, a1, u2, a2, u3, a3(finished)
    // Each message ~3K tokens, textPart.
    // lastAsstIdx = 5, startIdx = 4 (u3). Tail = u3(~3K) + a3(~3K) = ~6K.
    // Below minTokens but has 2 text blocks. Walk back: add a2(~3K), u2(~3K), a1(~3K), u1(~3K).
    // Cumulative: ~6K + 12K = ~18K, 6 text blocks. Both conditions met; stop.
    // Expected: boundary should be at or before u1 (but expansion is predictable).
    const msgs = [
      userMsg("u1", 0, textParts(3000)),
      asstMsg("a1", 10, "stop", textParts(3000)),
      userMsg("u2", 20, textParts(3000)),
      asstMsg("a2", 30, "stop", textParts(3000)),
      userMsg("u3", 40, textParts(3000)),
      asstMsg("a3", 50, "stop", textParts(3000)),
    ]
    const result = computeBoundary(msgs)
    // Should expand to include enough history to hit 10K floor and 5 text blocks.
    expect(["u1", "a1", "u2", "a2"]).toContain(result)
  })

  test("tail with no text blocks expands backward even at high tokens", () => {
    // Build: u1(~10K tool), a1(~10K tool), u2(~10K tool), a2(~10K tool),
    //        u3(no text), a3(no text, finished)
    // Tool parts don't count as text blocks. Tail u3+a3 has ~0 tokens but 0 text blocks.
    // Below minTextBlockMessages(5), so walk backward to include a2, u2, a1, u1.
    // Loop stops when textBlockCount >= 5 OR startIdx reaches 0 OR tailSum >= maxTokens.
    // Expected: walk back through tool-only messages until finding text-block messages or hitting limit.
    const msgs = [
      userMsg("u1", 0, toolParts(10000)),
      asstMsg("a1", 10, "stop", toolParts(10000)),
      userMsg("u2", 20, toolParts(10000)),
      asstMsg("a2", 30, "stop", toolParts(10000)),
      userMsg("u3", 40, []),
      asstMsg("a3", 50, "stop", []),
    ]
    const result = computeBoundary(msgs)
    // Should walk back to look for text blocks or hit max tokens.
    // Since tail has no text blocks, walks back to earlier messages.
    expect(["u1", "a1", "u2", "a2"]).toContain(result)
  })

  test("lastAsstIdx === 0 returns that msg", () => {
    // assistant is the very first message, no preceding user.
    const msgs = [asstMsg("a1", 10, "stop")]
    expect(computeBoundary(msgs)).toBe("a1")
  })
})
