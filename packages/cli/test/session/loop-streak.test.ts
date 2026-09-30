import { describe, expect, test } from "bun:test"
import {
  applyPersistedCrops,
  cropMessagesForStreak,
  cropMetadata,
  detectStreak,
  extractAllCrops,
  reasonHash,
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

  test("identical thinking with different narration and drifted tools still matches", () => {
    const thinking = "The user wants the SAME path as resume. That means classifyHarnessTurn first."
    const a = streakKey([reasoning(thinking), text("继续 A"), tool("edit", { file_path: "a.ts", new_string: "x" })])
    const b = streakKey([
      reasoning(thinking),
      text("继续 B"),
      tool("edit", { file_path: "b.ts", new_string: "y" }),
      tool("read", { file_path: "a.ts" }),
    ])
    expect(a).toBe(b)
    expect(a.startsWith("reason:")).toBe(true)
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
    expect(a.startsWith("reason:")).toBe(true)
  })

  test("tool-only loop keys on exact tool signature", () => {
    const a = streakKey([tool("edit", { file_path: "a.ts" })])
    const b = streakKey([tool("edit", { file_path: "a.ts" })])
    const c = streakKey([tool("edit", { file_path: "b.ts" })])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith("tool:")).toBe(true)
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

  test("MR-3931 shape: identical thinking with drifted tools is cropped", () => {
    const thinking = "The user wants the SAME path as resume."
    const steps = [
      msg("u0", "user", [text("我让你用同一个路径！")]),
      msg("a0", "assistant", [reasoning("look at code"), tool("read", { file_path: "harnessTurn.ts" })]),
      msg("a1", "assistant", [
        reasoning(thinking),
        text("改 classify"),
        tool("edit", { file_path: "harnessTurn.ts", new_string: "A" }),
      ]),
      msg("a2", "assistant", [
        reasoning(thinking),
        text("改 AssistantRow"),
        tool("edit", { file_path: "AssistantRow.tsx", new_string: "B" }),
      ]),
      msg("a3", "assistant", [
        reasoning(thinking),
        text("跑测试"),
        tool("bash", { command: "bun test" }),
      ]),
    ]
    const span = detectStreak(
      [
        { id: "a0", key: streakKey(steps[1].parts) },
        { id: "a1", key: streakKey(steps[2].parts) },
        { id: "a2", key: streakKey(steps[3].parts) },
        { id: "a3", key: streakKey(steps[4].parts) },
      ],
      3,
    )
    expect(span?.fromId).toBe("a1")
    expect(span?.anchorId).toBe("a0")
    const crop = cropMessagesForStreak(steps, span!)
    expect(crop.omitted).toEqual(["a1", "a2", "a3"])
    expect(crop.kept.map((m) => m.info.id)).toEqual(["u0", "a0"])
  })

  test("does not omit non-assistant messages inside id range", () => {
    const shared = [reasoning("same")]
    const messages = [
      msg("u0", "user", [text("start")]),
      msg("a1", "assistant", shared),
      msg("u_injected", "user", [text("reminder")]),
      msg("a2", "assistant", shared),
      msg("a3", "assistant", shared),
    ]
    const crop = cropMessagesForStreak(messages, {
      fromId: "a1",
      toId: "a3",
      anchorId: "u0",
      key: streakKey(shared),
      length: 3,
      truncated: false,
    })
    expect(crop.kept.map((m) => m.info.id)).toEqual(["u0", "u_injected"])
  })

  test("estimates cropped blocks and flags cache risk above 20", () => {
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
      key: streakKey(fat),
      length: 5,
      truncated: false,
    }
    const crop = cropMessagesForStreak(messages, span)
    expect(crop.omitted).toHaveLength(5)
    expect(crop.omittedMessages).toBe(5)
    expect(crop.omittedParts).toBe(5 * fat.length)
    expect(crop.cacheRisk).toBe(true)
    expect(crop.omittedBlocks).toBeGreaterThan(20)
    expect(crop.keptBlocks).toBeLessThan(crop.omittedBlocks)
  })

  test("keeps prefix order and part ids after crop", () => {
    const shared = [reasoning("same"), tool("edit", { file_path: "a.ts" })]
    const messages = [
      msg("u0", "user", [text("go")]),
      msg("a0", "assistant", [reasoning("plan")]),
      msg("a1", "assistant", shared),
      msg("a2", "assistant", shared),
      msg("a3", "assistant", shared),
    ]
    const crop = cropMessagesForStreak(messages, {
      fromId: "a1",
      toId: "a3",
      anchorId: "a0",
      key: streakKey(shared),
      length: 3,
      truncated: false,
    })
    expect(crop.kept.map((m) => m.info.id)).toEqual(["u0", "a0"])
    expect(crop.kept[1].parts.map((p) => p.id)).toEqual(messages[1].parts.map((p) => p.id))
  })
})

describe("persisted crop span", () => {
  const SAME_KEY = streakKey([reasoning("same")])

  /** Turn-recovery shape: span hangs on an existing user as ignored+synthetic. */
  const userWithSpan = (id: string, fromId: string, toId: string, key = SAME_KEY): StreakMessage => ({
    info: { id, role: "user" },
    parts: [
      {
        id: nextId(),
        sessionID: sid,
        messageID: MessageID.make(id.padEnd(26, "0").slice(0, 26)),
        type: "text",
        text: "user said something",
        synthetic: false,
      } as MessageV2.TextPart,
      {
        id: nextId(),
        sessionID: sid,
        messageID: MessageID.make(id.padEnd(26, "0").slice(0, 26)),
        type: "text",
        text: "",
        synthetic: true,
        ignored: true,
        metadata: cropMetadata({
          fromId,
          toId,
          anchorId: "a0",
          key,
          length: 3,
          truncated: false,
        }),
      } as MessageV2.TextPart,
    ],
  })

  test("extractAllCrops reads span from ignored user part", () => {
    const messages = [
      userWithSpan("u0", "a1", "a2"),
      msg("a1", "assistant", [reasoning("same")]),
      msg("a2", "assistant", [reasoning("same")]),
    ]
    expect(extractAllCrops(messages)).toEqual([
      {
        fromId: "a1",
        toId: "a2",
        key: SAME_KEY,
        truncated: false,
      },
    ])
  })

  test("crop stays active after a new user message (no new recovery user)", () => {
    const loop = [
      userWithSpan("u0", "a1", "a2"),
      msg("a1", "assistant", [reasoning("same")]),
      msg("a2", "assistant", [reasoning("same")]),
      msg("a3", "assistant", [reasoning("fresh")]),
      msg("u2", "user", [text("继续追问")]),
    ]
    const crops = extractAllCrops(loop)
    expect(crops).toHaveLength(1)
    const applied = applyPersistedCrops(loop, crops)
    expect(applied.omitted).toEqual(["a1", "a2"])
    // No extra user: only the original u0 (with span part) and later messages.
    expect(applied.kept.map((m) => m.info.id)).toEqual(["u0", "a3", "u2"])
  })

  test("extractAllCrops returns every span; applyPersistedCrops unions them", () => {
    const FRESH_KEY = streakKey([reasoning("fresh")])
    const messages = [
      msg("u0", "user", [text("go")]),
      msg("a1", "assistant", [reasoning("same")]),
      userWithSpan("u1", "a1", "a1", SAME_KEY),
      msg("a2", "assistant", [reasoning("fresh")]),
      userWithSpan("u2", "a2", "a2", FRESH_KEY),
    ]
    const crops = extractAllCrops(messages)
    expect(crops.map((c) => c.fromId)).toEqual(["a1", "a2"])
    const applied = applyPersistedCrops(messages, crops)
    expect(applied.omitted).toEqual(["a1", "a2"])
    expect(applied.kept.map((m) => m.info.id)).toEqual(["u0", "u1", "u2"])
  })

  test("applyPersistedCrops removes the same span every time", () => {
    const base = [
      msg("u0", "user", [text("go")]),
      msg("a0", "assistant", [reasoning("plan")]),
      msg("a1", "assistant", [reasoning("same")]),
      msg("a2", "assistant", [reasoning("same")]),
      userWithSpan("u1", "a1", "a2"),
    ]
    const withNewStep = [...base, msg("a3", "assistant", [reasoning("fresh plan")])]
    const crop = { fromId: "a1", toId: "a2", key: SAME_KEY, truncated: false }
    expect(applyPersistedCrops(base, [crop]).kept.map((m) => m.info.id)).toEqual(["u0", "a0", "u1"])
    expect(applyPersistedCrops(withNewStep, [crop]).kept.map((m) => m.info.id)).toEqual([
      "u0",
      "a0",
      "u1",
      "a3",
    ])
  })

  // Id must land inside [fromId, toId] lexicographically. "x_between" sorts
  // after "a3" and is already dropped by the id-range check, so it never
  // reaches the streakKey clause this test is meant to lock down.
  test("text-only assistant inside the id range is not cropped", () => {
    const shared = [reasoning("same plan")]
    const messages = [
      msg("u0", "user", [text("go")]),
      msg("a1", "assistant", shared),
      msg("a1narr", "assistant", [text("final narration, no tools")]),
      msg("a2", "assistant", shared),
      msg("a3", "assistant", shared),
    ]
    const key = streakKey(shared)
    const crop = cropMessagesForStreak(messages, {
      fromId: "a1",
      toId: "a3",
      anchorId: "u0",
      key,
      length: 3,
      truncated: false,
    })
    expect(crop.omitted).toEqual(["a1", "a2", "a3"])
    expect(crop.kept.map((m) => m.info.id)).toEqual(["u0", "a1narr"])
  })

  test("applyPersistedCrops keeps empty-key assistant inside the span id range", () => {
    const shared = [reasoning("same plan")]
    const key = streakKey(shared)
    const messages = [
      msg("u0", "user", [text("go")]),
      msg("a1", "assistant", shared),
      msg("a1narr", "assistant", [text("final narration, no tools")]),
      msg("a2", "assistant", shared),
      msg("a3", "assistant", shared),
      userWithSpan("u1", "a1", "a3", key),
    ]
    const applied = applyPersistedCrops(messages, [
      { fromId: "a1", toId: "a3", key, truncated: false },
    ])
    expect(applied.omitted).toEqual(["a1", "a2", "a3"])
    expect(applied.kept.map((m) => m.info.id)).toEqual(["u0", "a1narr", "u1"])
  })
})
