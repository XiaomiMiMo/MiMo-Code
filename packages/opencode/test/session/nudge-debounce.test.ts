import { describe, expect, test } from "bun:test"
import { nudgedSinceBoundary } from "../../src/session/prompt"

const MARKER = "Context is filling up"

// Minimal WithParts-shaped factories. nudgedSinceBoundary only touches
// m.info.id, m.info.role, and m.parts[].{type,text}, so we build just those.
function userMsg(id: string, texts: string[] = []): any {
  return {
    info: { id, role: "user" },
    parts: texts.map((t) => ({ type: "text", text: t })),
  }
}

function assistantStep(id: string, texts: string[] = []): any {
  return {
    info: { id, role: "assistant" },
    parts: texts.map((t) => ({ type: "text", text: t })),
  }
}

const NUDGE = `<system-reminder>\n${MARKER} (>85%).\n...</system-reminder>`

describe("nudgedSinceBoundary", () => {
  test("returns false when no nudge present", () => {
    const msgs = [userMsg("u1", ["hello"]), assistantStep("a1", ["hi"])]
    expect(nudgedSinceBoundary(msgs, undefined, MARKER)).toBe(false)
  })

  test("returns true when a nudge exists and no boundary (scan all)", () => {
    const msgs = [userMsg("u1", ["hello", NUDGE]), assistantStep("a1", ["working"])]
    expect(nudgedSinceBoundary(msgs, undefined, MARKER)).toBe(true)
  })

  // The core regression from PR #1613 review note 1: a single sustained
  // high-pressure turn emits many assistant steps (each its own message). A
  // fixed-size tail (e.g. last 8) would let the nudged message slide out and
  // re-fire the nudge mid-turn. Keying off the boundary keeps it suppressed.
  test("stays suppressed when nudged msg slides past a fixed window but is still in-episode", () => {
    const msgs = [
      userMsg("u1", ["do a big task", NUDGE]), // nudged here
      ...Array.from({ length: 20 }, (_, i) => assistantStep(`a${i}`, [`step ${i}`])),
    ]
    // No checkpoint boundary yet during this episode.
    expect(nudgedSinceBoundary(msgs, undefined, MARKER)).toBe(true)
    // Sanity: a naive last-8 window would MISS the nudge (proving the bug the
    // boundary approach fixes).
    const last8 = msgs.slice(-8)
    const naiveHit = last8.some((m: any) => m.parts.some((p: any) => p.text?.includes(MARKER)))
    expect(naiveHit).toBe(false)
  })

  test("allows a fresh nudge after a checkpoint boundary advances past the old one", () => {
    const msgs = [
      userMsg("u1", ["old work", NUDGE]), // nudged in the PREVIOUS episode
      assistantStep("a1", ["...done"]),
      userMsg("cp1"), // checkpoint boundary marker message
      userMsg("u2", ["new work"]), // new episode, not yet nudged
      assistantStep("a2", ["step"]),
    ]
    // Boundary points at the checkpoint message → episode = [cp1, u2, a2].
    // The old nudge (in u1) is BEFORE the boundary, so it must not suppress.
    expect(nudgedSinceBoundary(msgs, "cp1", MARKER)).toBe(false)
  })

  test("suppresses when the nudge is at/after the boundary", () => {
    const msgs = [
      userMsg("u1", ["old work"]),
      userMsg("cp1"), // boundary
      userMsg("u2", ["new work", NUDGE]), // nudged in the current episode
      assistantStep("a2", ["step"]),
    ]
    expect(nudgedSinceBoundary(msgs, "cp1", MARKER)).toBe(true)
  })

  test("boundary id not found in msgs falls back to scanning all messages", () => {
    const msgs = [userMsg("u1", ["work", NUDGE]), assistantStep("a1", ["step"])]
    // Stale/unknown boundary id → treat whole conversation as the episode.
    expect(nudgedSinceBoundary(msgs, "does-not-exist", MARKER)).toBe(true)
  })

  test("nudge exactly at the boundary message counts as in-episode", () => {
    const msgs = [
      userMsg("u1", ["old"]),
      userMsg("cp1", [NUDGE]), // boundary message itself carries the nudge
      assistantStep("a1", ["step"]),
    ]
    expect(nudgedSinceBoundary(msgs, "cp1", MARKER)).toBe(true)
  })
})
