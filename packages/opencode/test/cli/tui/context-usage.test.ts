import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@mimo-ai/sdk/v2"
import { computeContextUsage } from "../../../src/cli/cmd/tui/util/model"

// The footer's context readout (prompt/index.tsx `usage` memo) reads the LAST
// completed assistant turn's usage record. A manual /rebuild inserts only a
// checkpoint-boundary message; it produces no new usage record, so a naive
// findLast(output>0) keeps reporting the pre-rebuild figure until the next
// assistant turn — the number the user ran /rebuild to watch drop stays stale.
//
// These tests pin `computeContextUsage`, the pure function the memo delegates
// to, one level below the SolidJS render (there is no render harness for this
// component). The window is passed in already-resolved so the test does not
// depend on model/config plumbing.

const WINDOW = { hard: 1_000_000, effective: 980_000, usable: 960_000, source: "model" as const }

// computeContextUsage only reads id/role/tokens/cost; the rest of the SDK
// message shape is irrelevant here, so build the minimal object and cast.
function assistant(id: string, input: number, opts?: { cost?: number }): Message {
  return {
    id,
    role: "assistant",
    providerID: "alibaba",
    modelID: "qwen-plus",
    cost: opts?.cost ?? 0,
    tokens: { input, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
  } as AssistantMessage
}

function user(id: string): Message {
  return { id, role: "user" } as UserMessage
}

describe("computeContextUsage", () => {
  test("measured: reports the last assistant turn's context fill and cumulative cost", () => {
    // 578900 + 100 output = 579000 tokens over a 960K usable window → 579.0K/960K (60%).
    const messages = [user("msg_01"), assistant("msg_02", 578_900, { cost: 13.1 })]
    const out = computeContextUsage({ messages, window: WINDOW, hasCheckpoint: () => false })
    expect(out).toBeDefined()
    expect(out!.pending).toBe(false)
    expect(out!.context).toBe("579.0K/960K (60%)")
    expect(out!.cost).toBe(13.1)
  })

  test("after a manual /rebuild the stale pre-rebuild figure is NOT shown", () => {
    // The last assistant usage record (msg_02, 60%) predates a checkpoint
    // boundary inserted by /rebuild (msg_03). The measured figure is stale, so
    // the context readout must go pending instead of repeating "579.0K/960K (60%)".
    const messages = [user("msg_01"), assistant("msg_02", 578_900, { cost: 13.1 }), user("msg_03")]
    const out = computeContextUsage({
      messages,
      window: WINDOW,
      hasCheckpoint: (id) => id === "msg_03",
    })
    expect(out).toBeDefined()
    expect(out!.pending).toBe(true)
    // Must not repeat the stale pre-rebuild fill (this is the whole point).
    expect(out!.context).not.toBe("579.0K/960K (60%)")
    // Keep the frame, blank only the unmeasured numerator, and drop the percentage
    // (a percentage of an unknown numerator is meaningless).
    expect(out!.context).toBe("—/960K")
    expect(out!.context).not.toContain("%")
    // Cost is cumulative and independent of the context figure — it must survive.
    expect(out!.cost).toBe(13.1)
  })

  test("pending with no known window shows a bare placeholder (no frame to keep)", () => {
    // When the window is unknown the non-pending path shows only a bare token
    // count, so pending has no frame to preserve — a bare `—` is correct, and it
    // must still not carry a percentage or the stale token count.
    const messages = [user("msg_01"), assistant("msg_02", 578_900, { cost: 13.1 }), user("msg_03")]
    const out = computeContextUsage({
      messages,
      window: undefined,
      hasCheckpoint: (id) => id === "msg_03",
    })
    expect(out).toBeDefined()
    expect(out!.pending).toBe(true)
    expect(out!.context).toBe("—")
    expect(out!.context).not.toContain("%")
    expect(out!.context).not.toContain("579")
    expect(out!.cost).toBe(13.1)
  })

  test("config-source window keeps the ↓ marker in the pending frame", () => {
    // The frame includes the ↓ budget marker for a config-sourced window; pending
    // must preserve it so the user still sees they are on a configured budget.
    const messages = [user("msg_01"), assistant("msg_02", 578_900, { cost: 13.1 }), user("msg_03")]
    const out = computeContextUsage({
      messages,
      window: { hard: 1_000_000, effective: 980_000, usable: 960_000, source: "config" as const },
      hasCheckpoint: (id) => id === "msg_03",
    })
    expect(out).toBeDefined()
    expect(out!.pending).toBe(true)
    expect(out!.context).toBe("—/960K↓")
  })

  test("a fresh assistant turn after the boundary clears pending and re-measures", () => {
    // Once a new assistant turn completes AFTER the rebuild boundary, its usage
    // record is authoritative again: pending clears and the new figure shows.
    const messages = [
      user("msg_01"),
      assistant("msg_02", 578_900, { cost: 13.1 }),
      user("msg_03"),
      assistant("msg_04", 190_000, { cost: 14.0 }),
    ]
    const out = computeContextUsage({
      messages,
      window: WINDOW,
      hasCheckpoint: (id) => id === "msg_03",
    })
    expect(out).toBeDefined()
    expect(out!.pending).toBe(false)
    // 190000 + 100 = 190100 over 960K → 20%.
    expect(out!.context).toBe("190.1K/960K (20%)")
    // Cost is cumulative across all assistant turns (13.1 + 14.0), never reset.
    expect(out!.cost).toBeCloseTo(27.1, 5)
  })
})
