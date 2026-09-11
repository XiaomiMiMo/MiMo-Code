import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@mimo-ai/sdk/v2"
import { computeContextUsage } from "../../../src/cli/cmd/tui/util/model"

// The footer's context readout (prompt/index.tsx `usage` memo) reads the LAST
// completed assistant turn's usage record. A manual /rebuild inserts only a
// checkpoint-boundary message; it produces no new usage record, so a naive read
// keeps reporting the pre-rebuild figure until the next assistant turn — the
// number the user ran /rebuild to watch drop stays stale.
//
// These tests pin `computeContextUsage`, the pure function the memo delegates
// to, one level below the SolidJS render (there is no render harness for this
// component). The window is passed in already-resolved so the test does not
// depend on model/config plumbing. Staleness is driven by each checkpoint's
// `coveredUpTo` (the watermark id it collapsed up to) via `checkpointCoverage`,
// which is why these fixtures pass a coverage map rather than a boolean.

const WINDOW = { hard: 1_000_000, effective: 980_000, usable: 960_000, source: "model" as const }

// computeContextUsage reads id/role/tokens/cost and, in the order-independence
// tests, time.created; the rest of the SDK message shape is irrelevant, so build
// the minimal object and cast.
function assistant(id: string, input: number, opts?: { cost?: number; created?: number }): Message {
  return {
    id,
    role: "assistant",
    providerID: "alibaba",
    modelID: "qwen-plus",
    cost: opts?.cost ?? 0,
    time: { created: opts?.created ?? 0 },
    tokens: { input, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
  } as AssistantMessage
}

function user(id: string, opts?: { created?: number }): Message {
  return { id, role: "user", time: { created: opts?.created ?? 0 } } as UserMessage
}

// A checkpoint-boundary message: fresh ascending id, and (for the ordering
// tests) a deliberately backdated time.created — exactly the real shape from
// checkpoint.ts (`syntheticTime = boundaryCreatedAt + 1`, id = fresh ascending).
function boundary(id: string, opts?: { created?: number }): Message {
  return { id, role: "user", time: { created: opts?.created ?? 0 } } as UserMessage
}

/** Build the `checkpointCoverage` lookup from an id -> coveredUpTo map. */
function coverage(map: Record<string, string>) {
  return (id: string) => map[id]
}

describe("computeContextUsage", () => {
  test("measured: reports the last assistant turn's context fill and cumulative cost", () => {
    // 578900 + 100 output = 579000 tokens over a 960K usable window → 579.0K/960K (60%).
    const messages = [user("msg_01"), assistant("msg_02", 578_900, { cost: 13.1 })]
    const out = computeContextUsage({ messages, window: WINDOW, checkpointCoverage: () => undefined })
    expect(out).toBeDefined()
    expect(out!.pending).toBe(false)
    expect(out!.context).toBe("579.0K/960K (60%)")
    expect(out!.cost).toBe(13.1)
  })

  test("after a manual /rebuild the stale pre-rebuild figure is NOT shown", () => {
    // The last assistant usage record (msg_02, 60%) was collapsed by a /rebuild
    // boundary (msg_03) whose coveredUpTo is msg_02. The measured figure is stale,
    // so the readout must go pending instead of repeating "579.0K/960K (60%)".
    const messages = [user("msg_01"), assistant("msg_02", 578_900, { cost: 13.1 }), boundary("msg_03")]
    const out = computeContextUsage({
      messages,
      window: WINDOW,
      checkpointCoverage: coverage({ msg_03: "msg_02" }),
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
    const messages = [user("msg_01"), assistant("msg_02", 578_900, { cost: 13.1 }), boundary("msg_03")]
    const out = computeContextUsage({
      messages,
      window: undefined,
      checkpointCoverage: coverage({ msg_03: "msg_02" }),
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
    const messages = [user("msg_01"), assistant("msg_02", 578_900, { cost: 13.1 }), boundary("msg_03")]
    const out = computeContextUsage({
      messages,
      window: { hard: 1_000_000, effective: 980_000, usable: 960_000, source: "config" as const },
      checkpointCoverage: coverage({ msg_03: "msg_02" }),
    })
    expect(out).toBeDefined()
    expect(out!.pending).toBe(true)
    expect(out!.context).toBe("—/960K↓")
  })

  test("a fresh assistant turn after the boundary clears pending and re-measures", () => {
    // Once a new assistant turn completes AFTER the rebuild boundary, its usage
    // record is authoritative again: the boundary's coveredUpTo (msg_02) is older
    // than the new measured turn (msg_04), so pending clears and the figure shows.
    const messages = [
      user("msg_01"),
      assistant("msg_02", 578_900, { cost: 13.1 }),
      boundary("msg_03"),
      assistant("msg_04", 190_000, { cost: 14.0 }),
    ]
    const out = computeContextUsage({
      messages,
      window: WINDOW,
      checkpointCoverage: coverage({ msg_03: "msg_02" }),
    })
    expect(out).toBeDefined()
    expect(out!.pending).toBe(false)
    // 190000 + 100 = 190100 over 960K → 20%.
    expect(out!.context).toBe("190.1K/960K (20%)")
    // Cost is cumulative across all assistant turns (13.1 + 14.0), never reset.
    expect(out!.cost).toBeCloseTo(27.1, 5)
  })

  // Shared multi-rebuild fixture, engineered so id order and time order DISAGREE
  // and so the two rebuild markers' own ids straddle the measured turn:
  //
  //   ids (as sync stores them, ascending):  u0(msg_00) < bOld(msg_01) < a2(msg_04) < bCover(msg_05)
  //   time.created (backdated markers):       bCover(2) < bOld(9) < u0(100) < a2(101)
  //
  // Truth: bCover collapsed up to a2 (coveredUpTo = a2), so the last measured turn
  // a2 IS stale → pending. The trap for the old logic: in TIME order, the last
  // boundary in the array is bOld (msg_01), whose OWN id is LESS than a2 (msg_04),
  // so a `findLast(boundary).id > last.id` test would read NOT-pending — the exact
  // silent regression this change removes. coveredUpTo makes the verdict identical
  // in both orderings.
  const u0 = user("msg_00_u0", { created: 100 })
  const bOld = boundary("msg_01_bOld", { created: 9 }) // covers u0 only; late-ish time, small id
  const a2 = assistant("msg_04_a2", 300_000, { cost: 5.0, created: 101 })
  const bCover = boundary("msg_05_bCover", { created: 2 }) // covers a2; backdated, large id
  const multiCoverage = coverage({ msg_01_bOld: "msg_00_u0", msg_05_bCover: "msg_04_a2" })
  const idOrder = [u0, bOld, a2, bCover]

  test("two rebuilds in one session: still pending after the second, with backdated boundary times", () => {
    const out = computeContextUsage({ messages: idOrder, window: WINDOW, checkpointCoverage: multiCoverage })
    expect(out).toBeDefined()
    expect(out!.pending).toBe(true)
    expect(out!.context).toBe("—/960K")
  })

  test("order-independence: a time-sorted array yields the same pending verdict", () => {
    const timeOrder = [...idOrder].toSorted((x, y) => (x as any).time.created - (y as any).time.created)
    // Guard: the two orderings really are different (else this proves nothing), and
    // in time order the trailing boundary is bOld (small id) — the trap case.
    expect(timeOrder.map((m) => m.id)).not.toEqual(idOrder.map((m) => m.id))
    expect(timeOrder.map((m) => m.id)).toEqual(["msg_05_bCover", "msg_01_bOld", "msg_00_u0", "msg_04_a2"])

    const idOut = computeContextUsage({ messages: idOrder, window: WINDOW, checkpointCoverage: multiCoverage })
    const timeOut = computeContextUsage({ messages: timeOrder, window: WINDOW, checkpointCoverage: multiCoverage })
    expect(idOut).toEqual(timeOut)
    expect(timeOut!.pending).toBe(true)
    expect(timeOut!.context).toBe("—/960K")
  })
})
