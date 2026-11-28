import { describe, expect, test } from "bun:test"
import type { BackendPart, BackendSnapshot, BackendTurn } from "../src/ports"
import { SessionProjection } from "../src/projection"

type Text = {
  sequence: number
  snapshot: boolean
  contentRevision: number
  parts: (BackendPart & { revision: number; messageOrder: number; partOrder: number })[]
}
type State = {
  sequence: number
  contentRevision: number
  sessionPhase: string
  sessionTitle: string
  turns: {
    inputMessageId: string
    assistantMessageId: string
    phase: string
    revision: number
    finalContentRevision: number | null
  }[]
}

const user = (id: string, text: string): BackendPart => ({
  messageId: id,
  partId: `${id}_p`,
  role: "user",
  turnId: id,
  text,
})
const reply = (id: string, turnId: string, text: string, partId = `${id}_p`): BackendPart => ({
  messageId: id,
  partId,
  role: "assistant",
  turnId,
  text,
})
const turn = (input: string, assistant: string, phase: BackendTurn["phase"]): BackendTurn => ({
  inputMessageId: input,
  assistantMessageId: assistant,
  phase,
})
const snap = (
  parts: BackendPart[],
  turns: BackendTurn[],
  phase: BackendSnapshot["phase"] = "idle",
  title = "T",
): BackendSnapshot => ({
  title,
  phase,
  parts,
  turns,
})

function frames(projection: SessionProjection, snapshot: BackendSnapshot) {
  const result = projection.next(snapshot)
  if (typeof result === "string") throw new Error(result)
  return { text: result.text as unknown as Text | undefined, state: result.state as unknown as State | undefined }
}

describe("session projection", () => {
  test("the first publish is a paired snapshot sharing one epoch and content revision", () => {
    const projection = new SessionProjection("ses_1")
    const first = projection.next(snap([user("m1", "hi")], []))
    if (typeof first === "string") throw new Error(first)
    expect(first.text).toMatchObject({
      type: "event-text",
      desktopSessionId: "ses_1",
      projectionEpoch: projection.epoch,
      sequence: 0,
      snapshot: true,
      contentRevision: 1,
    })
    expect(first.state).toMatchObject({
      type: "event-state",
      projectionEpoch: projection.epoch,
      sequence: 0,
      snapshot: true,
      contentRevision: 1,
      sessionPhase: "idle",
      turns: [],
      sessionTitle: "T",
    })
    expect(Object.keys(first.text!)).toEqual([
      "type",
      "desktopSessionId",
      "projectionEpoch",
      "sequence",
      "snapshot",
      "contentRevision",
      "parts",
    ])
  })

  test("an empty session still publishes both lanes", () => {
    const { text, state } = frames(new SessionProjection("ses_1"), snap([], []))
    expect(text?.parts).toEqual([])
    expect(state?.contentRevision).toBe(1)
  })

  test("nothing is published again for an unchanged snapshot", () => {
    const projection = new SessionProjection("ses_1")
    const snapshot = snap([user("m1", "hi")], [])
    frames(projection, snapshot)
    expect(frames(projection, snapshot)).toEqual({ text: undefined, state: undefined })
  })

  test("text changes raise the content revision and only the changed part's revision", () => {
    const projection = new SessionProjection("ses_1")
    frames(projection, snap([user("m1", "hi"), reply("a1", "m1", "He")], [turn("m1", "a1", "running")], "running"))
    const { text, state } = frames(
      projection,
      snap([user("m1", "hi"), reply("a1", "m1", "Hello")], [turn("m1", "a1", "running")], "running"),
    )
    expect(text).toMatchObject({ sequence: 1, snapshot: false, contentRevision: 2 })
    expect(text!.parts.map((p) => [p.messageId, p.revision, p.messageOrder, p.partOrder])).toEqual([
      ["m1", 1, 0, 0],
      ["a1", 2, 1, 0],
    ])
    // Phase, title and turns are unchanged, so no state frame is needed.
    expect(state).toBeUndefined()
  })

  test("a finished turn points at the text revision that holds its whole reply", () => {
    const projection = new SessionProjection("ses_1")
    frames(projection, snap([user("m1", "hi"), reply("a1", "m1", "Hel")], [turn("m1", "a1", "running")], "running"))
    const done = frames(
      projection,
      snap([user("m1", "hi"), reply("a1", "m1", "Hello")], [turn("m1", "a1", "completed")]),
    )
    expect(done.text?.contentRevision).toBe(2)
    expect(done.state).toMatchObject({ sequence: 1, contentRevision: 2, sessionPhase: "idle" })
    expect(done.state!.turns).toEqual([
      { inputMessageId: "m1", assistantMessageId: "a1", phase: "completed", revision: 2, finalContentRevision: 2 },
    ])
    // Text of another turn does not move this turn's final revision.
    const later = frames(
      projection,
      snap([user("m1", "hi"), reply("a1", "m1", "Hello"), user("m2", "more")], [turn("m1", "a1", "completed")]),
    )
    expect(later.text?.contentRevision).toBe(3)
    expect(later.state).toBeUndefined()
    // Late tail text of a finished turn moves it forward.
    const tail = frames(
      projection,
      snap([user("m1", "hi"), reply("a1", "m1", "Hello!"), user("m2", "more")], [turn("m1", "a1", "completed")]),
    )
    expect(tail.state!.turns[0]).toMatchObject({ revision: 3, finalContentRevision: 4 })
    expect(tail.state!.contentRevision).toBe(4)
  })

  test("a turn that ends without any text is complete at the first revision", () => {
    const projection = new SessionProjection("ses_1")
    const { state } = frames(projection, snap([user("m1", "run it")], [turn("m1", "a1", "failed")]))
    expect(state!.turns[0]).toMatchObject({ phase: "failed", revision: 1, finalContentRevision: 1 })
  })

  test("unknown and running turns carry no final revision", () => {
    const { state } = frames(
      new SessionProjection("ses_1"),
      snap([user("m1", "a"), user("m2", "b")], [turn("m1", "a1", "unknown"), turn("m2", "a2", "running")], "running"),
    )
    expect(state!.turns.map((t) => t.finalContentRevision)).toEqual([null, null])
  })

  test("a part that leaves and comes back is republished above its old revision", () => {
    const projection = new SessionProjection("ses_1")
    frames(projection, snap([user("m1", "a"), reply("a1", "m1", "x")], []))
    frames(projection, snap([user("m1", "a")], []))
    const { text } = frames(projection, snap([user("m1", "a"), reply("a1", "m1", "x")], []))
    expect(text!.parts.find((p) => p.messageId === "a1")!.revision).toBe(2)
    expect(text!.parts.find((p) => p.messageId === "m1")!.revision).toBe(1)
  })

  test("a title change re-publishes state without a new content revision", () => {
    const projection = new SessionProjection("ses_1")
    frames(projection, snap([user("m1", "a")], []))
    const { text, state } = frames(projection, snap([user("m1", "a")], [], "idle", "Renamed"))
    expect(text).toBeUndefined()
    expect(state).toMatchObject({ sequence: 1, contentRevision: 1, sessionTitle: "Renamed" })
  })

  test("a phone-reserved control part is never produced", () => {
    const { text } = frames(
      new SessionProjection("ses_1"),
      snap(
        [
          {
            messageId: "mimo-remote-interaction",
            partId: "permission-state",
            role: "assistant",
            turnId: null,
            text: "{}",
          },
        ],
        [],
      ),
    )
    expect(text!.parts).toEqual([])
  })

  test("a session over the single-snapshot budget is reported as too large", () => {
    expect(new SessionProjection("ses_1").next({ ...snap([], []), complete: false })).toBe("projection_too_large")
    const tooManyTurns = Array.from({ length: 33 }, (_, i) => turn(`m${i}`, `a${i}`, "unknown"))
    expect(new SessionProjection("ses_1").next(snap([], tooManyTurns))).toBe("projection_too_large")
    const tooManyParts = Array.from({ length: 257 }, (_, i) => user(`m${i}`, "x"))
    expect(new SessionProjection("ses_1").next(snap(tooManyParts, []))).toBe("projection_too_large")
    expect(new SessionProjection("ses_1").next(snap([user("m1", "x".repeat(262_144))], []))).toBe(
      "projection_too_large",
    )
    // A full-length title alone fits the 16 KiB state frame; with 32 turns it does not.
    const title = "界".repeat(4096)
    expect(typeof new SessionProjection("ses_1").next(snap([], [], "idle", title))).toBe("object")
    const turns = Array.from({ length: 32 }, (_, i) =>
      turn(`msg_${"x".repeat(40)}${i}`, `msg_${"y".repeat(40)}${i}`, "unknown"),
    )
    expect(new SessionProjection("ses_1").next(snap([], turns, "idle", title))).toBe("projection_too_large")
  })

  test("a stream that has seen too many turns asks for a fresh subscription", () => {
    const projection = new SessionProjection("ses_1")
    for (let round = 0; round < 8; round++) {
      const turns = Array.from({ length: 32 }, (_, i) => turn(`m${round}_${i}`, `a${round}_${i}`, "unknown"))
      expect(typeof projection.next(snap([user(`m${round}`, "x")], turns))).toBe("object")
    }
    expect(projection.next(snap([user("m_last", "x")], [turn("m_last", "a_last", "unknown")]))).toBe("resync_required")
  })
})
