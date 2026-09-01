import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import {
  STEER_HINT_MARKER,
  buildSteerHint,
  hasRealUserText,
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

function msg(role: "user" | "assistant", id: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: { id, role, sessionID: "ses" } as unknown as MessageV2.WithParts["info"],
    parts,
  }
}

describe("steer hint", () => {
  test("skips first user message (no prior assistant)", () => {
    const first = msg("user", "u1", [textPart("do the thing")])
    expect(shouldInjectSteerHint([first], first)).toBe(false)
  })

  test("skips synthetic-only user messages", () => {
    const synthetic = msg("user", "u2", [textPart("auto continue", { synthetic: true })])
    const messages = [msg("user", "u1", [textPart("start")]), msg("assistant", "a1", [textPart("ok")]), synthetic]
    expect(shouldInjectSteerHint(messages, synthetic)).toBe(false)
  })

  test("fires on real user prose after assistant work", () => {
    const steer = msg("user", "u2", [textPart("also install the package")])
    const messages = [msg("user", "u1", [textPart("research names")]), msg("assistant", "a1", [textPart("working")]), steer]
    expect(shouldInjectSteerHint(messages, steer)).toBe(true)
  })

  test("single pending message is one keep-work sentence", () => {
    const notice = buildSteerHint(1)
    expect(notice).toContain(STEER_HINT_MARKER)
    expect(notice).toContain("keep that work unless the message clearly replaces it")
    expect(notice).not.toContain("unanswered user messages")
    expect(notice).toContain("<system-reminder>")
  })

  test("multiple pending messages name the set without re-embedding bodies", () => {
    const notice = buildSteerHint(3)
    expect(notice).toContain("3 unanswered user messages after your last reply")
    expect(notice).toContain("already in order above")
    expect(notice).not.toContain("install the package")
    expect(notice).not.toContain("Pending user messages (handle all of them):")
  })

  test("pendingUserMessages returns real users after last assistant", () => {
    const messages = [
      msg("user", "u1", [textPart("a")]),
      msg("assistant", "a1", [textPart("b")]),
      msg("user", "u2", [textPart("c")]),
      msg("user", "u3", [textPart("d")]),
    ]
    expect(pendingUserMessages(messages)).toHaveLength(2)
  })

  test("hasRealUserText ignores empty and synthetic parts", () => {
    expect(hasRealUserText(msg("user", "u1", [textPart("  ")]))).toBe(false)
    expect(hasRealUserText(msg("user", "u1", [textPart("x", { synthetic: true })]))).toBe(false)
    expect(hasRealUserText(msg("user", "u1", [textPart("x")]))).toBe(true)
  })

  test("does not treat full-context fork first task as a steer", () => {
    const parentAssistant = {
      info: { id: "pa1", role: "assistant", sessionID: "parent" },
      parts: [textPart("parent work")],
    } as unknown as MessageV2.WithParts
    const firstTask = msg("user", "u1", [textPart("child task")])
    expect(shouldInjectSteerHint([parentAssistant, firstTask], firstTask)).toBe(false)
  })
})
