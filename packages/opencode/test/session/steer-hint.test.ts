import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import {
  STEER_HINT_MARKER,
  buildSteerHint,
  hasRealUserText,
  lastRealUserMessage,
  pendingUserMessages,
  shouldInjectSteerHint,
} from "../../src/session/steer-hint"

function textPart(text: string, opts: { synthetic?: boolean } = {}): MessageV2.Part {
  return {
    id: `part_${Math.random().toString(36).slice(2, 10)}`,
    messageID: "msg",
    sessionID: "ses",
    type: "text",
    text,
    synthetic: opts.synthetic,
  } as unknown as MessageV2.Part
}

function msg(
  role: "user" | "assistant",
  id: string,
  parts: MessageV2.Part[],
  time?: { created: number; completed?: number },
  sessionID = "ses",
): MessageV2.WithParts {
  return {
    info: { id, role, sessionID, time: time ?? { created: 0 } } as unknown as MessageV2.WithParts["info"],
    parts,
  }
}

function asstInfo(id: string, time: { created: number; completed?: number }): MessageV2.Assistant {
  return { id, role: "assistant", sessionID: "ses", time } as unknown as MessageV2.Assistant
}

describe("steer hint", () => {
  test("skips step 0 (runLoop just started)", () => {
    const u1 = msg("user", "u1", [textPart("do the thing")], { created: 1 })
    expect(shouldInjectSteerHint({ messages: [u1], lastUser: u1, lastAssistant: undefined, step: 0 })).toBe(false)
  })

  test("skips when continuing current assistant (lastUser.id < lastAssistant.id)", () => {
    // MessageIDs are ascending — later messages must compare greater.
    const u2 = msg("user", "m2", [textPart("STEER")], { created: 4 })
    const a2 = msg("assistant", "m3", [textPart("answering")], { created: 5 })
    const messages = [
      msg("user", "m0", [textPart("first")], { created: 1 }),
      msg("assistant", "m1", [textPart("done")], { created: 2, completed: 3 }),
      u2,
      a2,
    ]
    expect(
      shouldInjectSteerHint({
        messages,
        lastUser: u2,
        lastAssistant: asstInfo("m3", { created: 5 }),
        step: 2,
      }),
    ).toBe(false)
  })

  test("skips synthetic-only user", () => {
    const synthetic = msg("user", "u2", [textPart("auto continue", { synthetic: true })], { created: 3 })
    expect(
      shouldInjectSteerHint({
        messages: [synthetic],
        lastUser: synthetic,
        lastAssistant: asstInfo("a1", { created: 1, completed: 2 }),
        step: 1,
      }),
    ).toBe(false)
  })

  test("fires when loop step ≥ 1 sees a new lastUser (mid-turn steer)", () => {
    const steer = msg("user", "u2", [textPart("also install the package")], { created: 4 })
    const messages = [
      msg("user", "u1", [textPart("research names")], { created: 1 }),
      msg("assistant", "a1", [textPart("working")], { created: 2 }),
      steer,
    ]
    expect(
      shouldInjectSteerHint({
        messages,
        lastUser: steer,
        lastAssistant: asstInfo("a1", { created: 2 }),
        step: 1,
      }),
    ).toBe(true)
  })

  test("fires for stacked steers at step ≥ 1", () => {
    const b = msg("user", "u3", [textPart("STEER_B")], { created: 21 })
    expect(
      shouldInjectSteerHint({
        messages: [b],
        lastUser: b,
        lastAssistant: asstInfo("a1", { created: 2, completed: 5 }),
        step: 3,
      }),
    ).toBe(true)
  })

  test("lastRealUserMessage skips newer synthetic inbox users", () => {
    const real = msg("user", "u2", [textPart("STEER")], { created: 4 })
    const drain = msg("user", "u3", [textPart("notification", { synthetic: true })], { created: 5 })
    const messages = [
      msg("user", "u1", [textPart("first")], { created: 1 }),
      msg("assistant", "a1", [textPart("done")], { created: 2, completed: 3 }),
      real,
      drain,
    ]
    expect(String(lastRealUserMessage(messages)?.info.id)).toBe("u2")
  })

  test("hint text", () => {
    expect(buildSteerHint(1)).toContain(STEER_HINT_MARKER)
    expect(buildSteerHint(1)).toContain("keep that work unless")
    expect(buildSteerHint(3)).toContain("3 unanswered user messages")
  })

  test("pendingUserMessages", () => {
    const messages = [
      msg("user", "u1", [textPart("a")], { created: 1 }),
      msg("assistant", "a1", [textPart("b")], { created: 2, completed: 3 }),
      msg("user", "u2", [textPart("c")], { created: 4 }),
      msg("user", "u3", [textPart("d")], { created: 5 }),
    ]
    expect(pendingUserMessages(messages)).toHaveLength(2)
  })

  test("hasRealUserText", () => {
    expect(hasRealUserText(msg("user", "u1", [textPart("  ")]))).toBe(false)
    expect(hasRealUserText(msg("user", "u1", [textPart("x", { synthetic: true })]))).toBe(false)
    expect(hasRealUserText(msg("user", "u1", [textPart("x")]))).toBe(true)
  })
})
