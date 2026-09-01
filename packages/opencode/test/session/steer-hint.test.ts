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
    info: {
      id,
      role,
      sessionID,
      time: time ?? { created: 0 },
    } as unknown as MessageV2.WithParts["info"],
    parts,
  }
}

describe("steer hint", () => {
  test("skips first user message (no prior assistant)", () => {
    const first = msg("user", "u1", [textPart("do the thing")], { created: 1 })
    expect(shouldInjectSteerHint([first], first)).toBe(false)
  })

  test("skips synthetic-only user messages", () => {
    const synthetic = msg("user", "u2", [textPart("auto continue", { synthetic: true })], { created: 3 })
    const messages = [
      msg("user", "u1", [textPart("start")], { created: 1 }),
      msg("assistant", "a1", [textPart("ok")], { created: 2, completed: 2 }),
      synthetic,
    ]
    expect(shouldInjectSteerHint(messages, synthetic)).toBe(false)
  })

  test("skips ordinary sequential turn after a finished reply", () => {
    const next = msg("user", "u2", [textPart("next task")], { created: 10 })
    const messages = [
      msg("user", "u1", [textPart("first")], { created: 1 }),
      msg("assistant", "a1", [textPart("done")], { created: 2, completed: 5 }),
      next,
    ]
    expect(shouldInjectSteerHint(messages, next)).toBe(false)
  })

  test("skips when an assistant already answers this user (current turn)", () => {
    const u2 = msg("user", "u2", [textPart("STEER")], { created: 4 })
    const a2 = msg("assistant", "a2", [textPart("working on steer")], { created: 5 })
    const messages = [
      msg("user", "u1", [textPart("first")], { created: 1 }),
      msg("assistant", "a1", [textPart("done")], { created: 2, completed: 3 }),
      u2,
      a2,
    ]
    expect(shouldInjectSteerHint(messages, u2)).toBe(false)
  })

  test("fires when user arrived while prior assistant was still open and unanswered", () => {
    const steer = msg("user", "u2", [textPart("also install the package")], { created: 4 })
    const messages = [
      msg("user", "u1", [textPart("research names")], { created: 1 }),
      msg("assistant", "a1", [textPart("working")], { created: 2, completed: 10 }),
      steer,
    ]
    expect(shouldInjectSteerHint(messages, steer)).toBe(true)
  })

  test("fires when multiple real users are stacked after last assistant", () => {
    const a = msg("user", "u2", [textPart("STEER_A")], { created: 20 })
    const b = msg("user", "u3", [textPart("STEER_B")], { created: 21 })
    const messages = [
      msg("user", "u1", [textPart("first")], { created: 1 }),
      msg("assistant", "a1", [textPart("done")], { created: 2, completed: 5 }),
      a,
      b,
    ]
    expect(shouldInjectSteerHint(messages, b)).toBe(true)
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

  test("single pending message is one keep-work sentence", () => {
    const notice = buildSteerHint(1)
    expect(notice).toContain(STEER_HINT_MARKER)
    expect(notice).toContain("keep that work unless the message clearly replaces it")
    expect(notice).not.toContain("unanswered user messages")
  })

  test("multiple pending messages name the set without re-embedding bodies", () => {
    const notice = buildSteerHint(3)
    expect(notice).toContain("3 unanswered user messages after your last reply")
    expect(notice).not.toContain("install the package")
  })

  test("pendingUserMessages returns real users after last assistant", () => {
    const messages = [
      msg("user", "u1", [textPart("a")], { created: 1 }),
      msg("assistant", "a1", [textPart("b")], { created: 2, completed: 3 }),
      msg("user", "u2", [textPart("c")], { created: 4 }),
      msg("user", "u3", [textPart("d")], { created: 5 }),
    ]
    expect(pendingUserMessages(messages)).toHaveLength(2)
  })

  test("hasRealUserText ignores empty and synthetic parts", () => {
    expect(hasRealUserText(msg("user", "u1", [textPart("  ")]))).toBe(false)
    expect(hasRealUserText(msg("user", "u1", [textPart("x", { synthetic: true })]))).toBe(false)
    expect(hasRealUserText(msg("user", "u1", [textPart("x")]))).toBe(true)
  })

  test("does not treat full-context fork first task as a steer", () => {
    const parentAssistant = msg("assistant", "pa1", [textPart("parent work")], { created: 1, completed: 2 }, "parent")
    const firstTask = msg("user", "u1", [textPart("child task")], { created: 3 })
    expect(shouldInjectSteerHint([parentAssistant, firstTask], firstTask)).toBe(false)
  })
})
