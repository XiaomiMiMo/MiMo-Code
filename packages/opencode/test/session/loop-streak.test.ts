import { describe, expect, test } from "bun:test"
import {
  cropMessagesForStreak,
  detectStreak,
  estimateBlocks,
  reasonHash,
  recoveryNote,
  streakKey,
  toolSignature,
  type StreakEntry,
  type StreakMessage,
} from "../../src/session/prompt/loop-streak"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sid = SessionID.make("ses_loopstreak000000000000")
const mid = MessageID.make("msg_loopstreak00000000000")

const partId = (n: number) => PartID.make(`prt_loopstreak${String(n).padStart(10, "0")}`)

let partSeq = 0
const nextId = () => partId(partSeq++)

const reasoning = (text: string): MessageV2.ReasoningPart => ({
  id: nextId(),
  sessionID: sid,
  messageID: mid,
  type: "reasoning",
  text,
  time: { start: 1, end: 2 },
})

const tool = (name: string, input: Record<string, unknown>): MessageV2.ToolPart => ({
  id: nextId(),
  sessionID: sid,
  messageID: mid,
  type: "tool",
  tool: name,
  callID: `call_${name}`,
  state: {
    status: "completed",
    input,
    output: "ok",
    title: name,
    metadata: {},
    time: { start: 1, end: 2 },
  },
})

const text = (body: string): MessageV2.TextPart => ({
  id: nextId(),
  sessionID: sid,
  messageID: mid,
  type: "text",
  text: body,
})

const msg = (id: string, role: MessageV2.Info["role"], parts: MessageV2.Part[]): StreakMessage => ({
  info: { id, role },
  parts,
})

describe("streakKey", () => {
  test("empty reasoning and tools yields empty key", () => {
    expect(streakKey([text("hello")])).toBe("")
  })

  test("identical thinking with different narration still matches", () => {
    const thinking = "The user wants the SAME path as resume. That means classifyHarnessTurn first."
    const a = streakKey([reasoning(thinking), text("继续 A"), tool("edit", { file_path: "a.ts", new_string: "x" })])
    const b = streakKey([reasoning(thinking), text("继续 B"), tool("edit", { file_path: "a.ts", new_string: "x" })])
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  test("different thinking yields different keys", () => {
    const a = streakKey([reasoning("first plan"), tool("edit", { file_path: "a.ts" })])
    const b = streakKey([reasoning("second plan"), tool("edit", { file_path: "a.ts" })])
    expect(a).not.toBe(b)
  })

  test("tool key order is independent of object key insertion order", () => {
    const a = toolSignature([tool("edit", { file_path: "a.ts", new_string: "x" })])
    const b = toolSignature([tool("edit", { new_string: "x", file_path: "a.ts" })])
    expect(a).toBe(b)
  })

  test("reasoning fragments join before hashing", () => {
    const one = reasonHash([reasoning("hello world")])
    const many = reasonHash([reasoning("hello "), reasoning("world")])
    expect(one).toBe(many)
  })

  test("thinking-only loop keys on reason hash alone", () => {
    const a = streakKey([reasoning("same thought")])
    const b = streakKey([reasoning("same thought"), text("narration changes")])
    expect(a).toBe(b)
    expect(a.endsWith("\0")).toBe(true)
  })
})

const entry = (id: string, key: string): StreakEntry => ({ id, key })

describe("detectStreak", () => {
  test("returns undefined below trigger count", () => {
    expect(detectStreak([entry("a", "k"), entry("b", "k")], 3)).toBeUndefined()
  })

  test("returns undefined when tail keys differ", () => {
    expect(detectStreak([entry("a", "k"), entry("b", "k"), entry("c", "j")], 3)).toBeUndefined()
  })

  test("returns undefined for empty key", () => {
    expect(detectStreak([entry("a", ""), entry("b", ""), entry("c", "")], 3)).toBeUndefined()
  })

  test("span walks back through identical keys and keeps predecessor as anchor", () => {
    const span = detectStreak(
      [entry("m0", "prev"), entry("m1", "k"), entry("m2", "k"), entry("m3", "k")],
      3,
    )
    expect(span).toEqual({
      fromId: "m1",
      toId: "m3",
      anchorId: "m0",
      key: "k",
      length: 3,
      truncated: false,
    })
  })

  test("long streak respects max span and keeps trailing window", () => {
    const entries = [entry("m0", "prev"), ...Array.from({ length: 10 }, (_, i) => entry(`m${i + 1}`, "k"))]
    const span = detectStreak(entries, 3, 4)
    expect(span?.fromId).toBe("m7")
    expect(span?.toId).toBe("m10")
    expect(span?.length).toBe(4)
    expect(span?.truncated).toBe(true)
    expect(span?.anchorId).toBe("m6")
  })

  test("no predecessor leaves anchor undefined", () => {
    const span = detectStreak([entry("m1", "k"), entry("m2", "k"), entry("m3", "k")], 3)
    expect(span?.anchorId).toBeUndefined()
  })
})

describe("cropMessagesForStreak", () => {
  test("omits only the span assistants and keeps anchor", () => {
    const shared = [reasoning("same"), tool("edit", { file_path: "a.ts" })]
    const messages = [
      msg("u0", "user", [text("do it")]),
      msg("a0", "assistant", [reasoning("plan"), tool("read", { file_path: "a.ts" })]),
      msg("a1", "assistant", shared),
      msg("a2", "assistant", shared),
      msg("a3", "assistant", shared),
    ]
    const span = detectStreak(
      [
        { id: "a1", key: streakKey(shared) },
        { id: "a2", key: streakKey(shared) },
        { id: "a3", key: streakKey(shared) },
      ],
      3,
    )
    expect(span).toBeDefined()
    const crop = cropMessagesForStreak(messages, span!)
    expect(crop.omitted).toEqual(["a1", "a2", "a3"])
    expect(crop.kept.map((m) => m.info.id)).toEqual(["u0", "a0"])
    expect(crop.remainingSimilar).toBe(0)
  })

  test("does not omit non-assistant messages inside id range", () => {
    const messages = [
      msg("u0", "user", [text("start")]),
      msg("a1", "assistant", [reasoning("same")]),
      msg("u_injected", "user", [text("reminder")]),
      msg("a2", "assistant", [reasoning("same")]),
      msg("a3", "assistant", [reasoning("same")]),
    ]
    const crop = cropMessagesForStreak(messages, {
      fromId: "a1",
      toId: "a3",
      anchorId: "u0",
      key: "k",
      length: 3,
      truncated: false,
    })
    expect(crop.kept.map((m) => m.info.id)).toEqual(["u0", "u_injected"])
  })

  test("estimates blocks and flags cache risk above 20 removed blocks", () => {
    const fat = [
      reasoning("think"),
      text("say"),
      tool("edit", { file_path: "a.ts" }),
      tool("edit", { file_path: "b.ts" }),
      tool("edit", { file_path: "c.ts" }),
    ]
    const messages = [
      msg("u0", "user", [text("go")]),
      ...Array.from({ length: 5 }, (_, i) => msg(`a${i}`, "assistant", fat)),
    ]
    const span = {
      fromId: "a0",
      toId: "a4",
      anchorId: "u0",
      key: "k",
      length: 5,
      truncated: false,
    }
    const crop = cropMessagesForStreak(messages, span)
    expect(crop.omitted).toHaveLength(5)
    expect(crop.cacheRisk).toBe(true)
    expect(estimateBlocks(messages)).toBeGreaterThan(estimateBlocks(crop.kept) + 20)
  })

  test("recovery note mentions omitted count and abandon plan", () => {
    const note = recoveryNote(
      {
        fromId: "a1",
        toId: "a3",
        anchorId: "a0",
        key: "k",
        length: 3,
        truncated: false,
      },
      {
        kept: [],
        omitted: ["a1", "a2", "a3"],
        remainingSimilar: 2,
        estBlocks: 0,
        cacheRisk: true,
      },
    )
    expect(note).toContain("3 step(s) were omitted")
    expect(note).toContain("2 earlier similar step(s)")
    expect(note).toContain("Abandon that plan")
  })
})
