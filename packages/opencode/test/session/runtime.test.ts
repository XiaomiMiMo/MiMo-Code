import { describe, expect, test } from "bun:test"
import { RuntimeProjection } from "../../src/session/runtime"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("ses_runtime")
const messageID = MessageID.make("msg_runtime")
const partID = PartID.make("prt_runtime")
const info = { id: messageID, sessionID, agentID: "worker", role: "user", time: { created: 1 }, agent: "test", model: { providerID: "test", modelID: "test" } } as MessageV2.Info
const part: MessageV2.TextPart = { id: partID, messageID, sessionID, type: "text", text: "ha" }
function fixture() {
  const messages: MessageV2.WithParts[] = [{ info, parts: [structuredClone(part)] }]
  const runtime = new RuntimeProjection(() => ({ messages: structuredClone(messages), actors: [], revert: null }))
  return { runtime, messages }
}

describe("runtime error occurrences", () => {
  const failure = { name: "UnknownError", data: { message: "failed" } } as NonNullable<MessageV2.Assistant["error"]>
  const assistant = { ...info, id: MessageID.make("msg_assistant"), role: "assistant", parentID: messageID, error: failure, time: { created: 2 } } as MessageV2.Assistant

  test("metadata then event uses one message occurrence", () => {
    const { runtime, messages } = fixture()
    messages.push({ info: assistant, parts: [] })
    runtime.record(sessionID, { type: "message.updated", properties: { info: assistant } })
    const event = runtime.record(sessionID, { type: "session.error", properties: { sessionID, ownerActorId: "worker", messageID: assistant.id, error: failure } }, "worker")
    expect(event?.properties.event.properties).toMatchObject({ id: `msg:${assistant.id}`, messageID: assistant.id, at: expect.any(Number) })
    expect(runtime.snapshot(sessionID).errors).toEqual([{ actorID: "worker", id: `msg:${assistant.id}`, messageID: assistant.id, at: expect.any(Number), error: failure }])
  })

  test("event then metadata preserves occurrence without a duplicate", () => {
    const { runtime, messages } = fixture()
    messages.push({ info: { ...assistant, error: undefined }, parts: [] })
    runtime.record(sessionID, { type: "session.error", properties: { sessionID, messageID: assistant.id, error: failure } }, "worker")
    messages[1].info = assistant
    runtime.record(sessionID, { type: "message.updated", properties: { info: assistant } })
    expect(runtime.snapshot(sessionID).errors).toHaveLength(1)
    expect(runtime.snapshot(sessionID).errors[0].id).toBe(`msg:${assistant.id}`)
  })

  test("postStop error after completed assistant remains independent across snapshot", () => {
    const { runtime, messages } = fixture()
    messages.push({ info: { ...assistant, error: undefined, time: { created: 2, completed: 3 } }, parts: [] })
    const event = runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
    expect(event?.properties.event.properties).toMatchObject({ id: "event:1", anchorMessageID: assistant.id })
    expect(event?.properties.event.properties.messageID).toBeUndefined()
    expect(runtime.snapshot(sessionID).errors).toEqual([{ actorID: "worker", id: "event:1", anchorMessageID: assistant.id, at: expect.any(Number), error: failure }])
  })

  test("preassistant errors anchor to user and preserve distinct equal-text occurrences", () => {
    const { runtime } = fixture()
    runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
    runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
    expect(runtime.snapshot(sessionID).errors.map(({ id, anchorMessageID }) => ({ id, anchorMessageID }))).toEqual([
      { id: "event:1", anchorMessageID: messageID },
      { id: "event:2", anchorMessageID: messageID },
    ])
  })

  test("message removal and explicit metadata clearing remove only their occurrence", () => {
    const { runtime, messages } = fixture()
    messages.push({ info: assistant, parts: [] })
    runtime.record(sessionID, { type: "message.updated", properties: { info: assistant } })
    runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
    messages.pop()
    runtime.record(sessionID, { type: "message.removed", properties: { sessionID, messageID: assistant.id } }, "worker")
    expect(runtime.snapshot(sessionID).errors.map((entry) => entry.id)).toEqual(["event:2"])
    messages.push({ info: assistant, parts: [] })
    runtime.record(sessionID, { type: "message.updated", properties: { info: assistant } })
    messages[1].info = { ...assistant, error: undefined }
    runtime.record(sessionID, { type: "message.updated", properties: { info: messages[1].info } })
    expect(runtime.snapshot(sessionID).errors.map((entry) => entry.id)).toEqual(["event:2"])
  })

  test("metadata clear uses its message update without a duplicate clear event", () => {
    const { runtime, messages } = fixture()
    messages.push({ info: assistant, parts: [] })
    runtime.record(sessionID, { type: "message.updated", properties: { info: assistant } })
    const events: ReturnType<typeof runtime.record>[] = []
    runtime.subscribe((event) => events.push(event))
    messages[1].info = { ...assistant, error: undefined }
    const update = runtime.record(sessionID, { type: "message.updated", properties: { info: messages[1].info } })
    expect(runtime.snapshot(sessionID).errors).toEqual([])
    expect(events).toEqual([update])
    expect(update?.properties.event.properties.info).toMatchObject({ id: assistant.id, error: undefined })
  })

  test("same-startedAt runner reentry clears each old occurrence before actor runtime, never a later error", () => {
    const { runtime, messages } = fixture()
    messages.push({ info: assistant, parts: [] })
    runtime.record(sessionID, { type: "message.updated", properties: { info: assistant } })
    runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
    runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "other")
    const old = runtime.snapshot(sessionID)
    const events: ReturnType<typeof runtime.record>[] = []
    runtime.subscribe((event) => events.push(event))
    runtime.execution(sessionID, "worker", true)
    const first = runtime.snapshot(sessionID)
    expect(events.map((event) => event?.properties.event.type)).toEqual(["actor.error.clear", "actor.error.clear", "actor.runtime"])
    expect(events.slice(0, 2).map((event) => event?.properties.event.properties)).toEqual([
      { sessionID, actorID: "worker", id: `msg:${assistant.id}` },
      { sessionID, actorID: "worker", id: "event:2" },
    ])
    expect(events.map((event) => event?.properties.seq)).toEqual([old.throughSeq + 1, old.throughSeq + 2, old.throughSeq + 3])
    expect(events.every((event) => event?.properties.epoch === runtime.epoch && event.properties.sessionID === sessionID)).toBe(true)
    expect(first.errors.map((error) => error.id)).toEqual(["event:3"])
    expect(first.throughSeq).toBe(events.at(-1)!.properties.seq)
    const startedAt = first.actors.find((actor) => actor.actorID === "worker")?.startedAt
    const recent = runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
    const offset = events.length
    runtime.execution(sessionID, "worker", true)
    expect(runtime.snapshot(sessionID).actors.find((actor) => actor.actorID === "worker")?.startedAt).toBe(startedAt)
    expect(events.slice(offset).map((event) => event?.properties.event.type)).toEqual(["actor.error.clear", "actor.runtime"])
    expect(events[offset]?.properties.event.properties).toEqual({ sessionID, actorID: "worker", id: recent?.properties.event.properties.id })
    expect(events[offset]?.properties.seq).toBe(recent!.properties.seq + 1)
    expect(runtime.snapshot(sessionID).errors.map((error) => error.id)).toEqual(["event:3"])
    const newer = runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
    expect(runtime.snapshot(sessionID).errors.map((error) => error.id)).toEqual(["event:3", String(newer?.properties.event.properties.id)])
    const quiet = events.length
    runtime.execution(sessionID, "other", true)
    expect(events.slice(quiet).map((event) => event?.properties.event.type)).toEqual(["actor.error.clear", "actor.runtime"])
    expect(runtime.snapshot(sessionID).errors.map((error) => error.id)).toEqual([String(newer?.properties.event.properties.id)])
  })

  test("an error published during clear is not swept into the previous execution cycle", () => {
    const { runtime } = fixture()
    runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
    runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
    const types: string[] = []
    runtime.subscribe((envelope) => {
      types.push(envelope.properties.event.type)
      if (envelope.properties.event.type === "actor.error.clear" && envelope.properties.event.properties.id === "event:1") {
        runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
      }
    })
    runtime.execution(sessionID, "worker", true)
    expect(types).toEqual(["actor.error.clear", "session.error", "actor.error.clear", "actor.runtime"])
    expect(runtime.snapshot(sessionID).errors.map((error) => error.id)).toEqual(["event:4"])
    expect(runtime.snapshot(sessionID).throughSeq).toBe(6)
  })

  test("ownership false to true clears only current actor errors before runtime and isolates epochs", () => {
    let owned: string[] = []
    const runtime = new RuntimeProjection(() => ({ messages: [{ info, parts: [] }], actors: [], revert: null }), undefined, () => owned)
    const old = runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: failure } }, "worker")
    const events: ReturnType<typeof runtime.record>[] = []
    runtime.subscribe((event) => events.push(event))
    owned = ["worker"]
    runtime.refreshExecution(sessionID, "worker")
    expect(events.map((event) => event?.properties.event.type)).toEqual(["actor.error.clear", "actor.runtime"])
    expect(events[0]?.properties.event.properties).toEqual({ sessionID, actorID: "worker", id: old?.properties.event.properties.id })
    expect(events.map((event) => event?.properties.seq)).toEqual([2, 3])
    expect(runtime.snapshot(sessionID)).toMatchObject({ throughSeq: 3, errors: [] })
    const quiet = events.length
    runtime.refreshExecution(sessionID, "worker")
    expect(events.slice(quiet).map((event) => event?.properties.event.type)).toEqual(["actor.runtime"])
    const next = fixture().runtime
    expect(next.epoch).not.toBe(runtime.epoch)
    expect(next.snapshot(sessionID).errors).toEqual([])
  })
})

describe("runtime snapshot boundary", () => {
  // [TP-R17-04] [TP-R17-05]
  test("cut contains undurable repeated deltas and stays frozen while later events advance", () => {
    const { runtime } = fixture()
    const events: number[] = []
    runtime.subscribe((event) => events.push(event.properties.seq))
    runtime.record(sessionID, { type: "message.part.delta", properties: { sessionID, messageID, partID, field: "text", delta: "ha" } })
    const cut = runtime.snapshot(sessionID)
    runtime.record(sessionID, { type: "message.part.delta", properties: { sessionID, messageID, partID, field: "text", delta: "ha" } })
    expect(cut.messages[0].parts[0]).toMatchObject({ text: "haha" })
    expect(cut.throughSeq).toBe(1)
    expect(runtime.snapshot(sessionID).messages[0].parts[0]).toMatchObject({ text: "hahaha" })
    expect(events).toEqual([1, 2])
  })

  // [TP-R17-04]
  test("full replacement may shrink; removal cannot resurrect an overlay", () => {
    const { runtime, messages } = fixture()
    runtime.record(sessionID, { type: "message.part.delta", properties: { sessionID, messageID, partID, field: "text", delta: "ha" } })
    messages[0].parts[0] = { ...part, text: "x" }
    runtime.record(sessionID, { type: "message.part.updated", properties: { part: messages[0].parts[0] } })
    expect(runtime.snapshot(sessionID).messages[0].parts[0]).toMatchObject({ text: "x" })
    messages[0].parts = []
    runtime.record(sessionID, { type: "message.part.removed", properties: { sessionID, messageID, partID } })
    expect(runtime.snapshot(sessionID).messages[0].parts).toEqual([])
  })

  // [TP-R17-01] [TP-R17-02]
  test("source identity comes from message, never the actor tool target; unknown stays unknown", () => {
    const { runtime } = fixture()
    const known = runtime.record(sessionID, { type: "message.part.updated", properties: { part: { ...part, actorId: "target" } } })
    expect(known?.properties.ownerActorId).toBe("worker")
    const unknown = runtime.record(sessionID, { type: "session.error", properties: { sessionID, error: { name: "UnknownError" } } })
    expect(unknown?.properties.ownerActorId).toBeUndefined()
  })

  // [TP-R17-02]
  test("empty and internal part updates do not clear another actor's wait", () => {
    const { runtime } = fixture()
    runtime.retry(sessionID, "worker", { type: "retry", attempt: 2, message: "wait", next: 100 })
    runtime.record(sessionID, { type: "message.part.updated", properties: { part: { ...part, type: "reasoning", text: "" } } })
    runtime.record(sessionID, { type: "message.updated", properties: { info: { ...info, agentID: "main" } } })
    expect(runtime.snapshot(sessionID).retries).toHaveLength(1)
    runtime.clearRetry(sessionID, "main")
    expect(runtime.snapshot(sessionID).retries).toHaveLength(1)
    runtime.clearRetry(sessionID, "worker")
    expect(runtime.snapshot(sessionID).retries).toEqual([])
  })

  // [TP-R17-05]
  test("epochs isolate independent runtime instances", () => {
    expect(fixture().runtime.epoch).not.toBe(fixture().runtime.epoch)
  })
})
