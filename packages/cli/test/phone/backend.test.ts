import { describe, expect, test } from "bun:test"
import type { Event, Session, SessionStatus } from "@mimo-ai/sdk/v2"
import { MimoBackend, type EngineApi, type EngineEvents, type Receipt } from "../../src/phone/backend"
import type { MessageWithParts } from "../../src/phone/mirror"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse("2026-11-03T12:00:00Z")

function session(id: string, updated: number, created: number, extra: Partial<Session> = {}): Session {
  return { id, title: `Title ${id}`, time: { updated, created }, ...extra } as Session
}

const user = (id: string, text: string, extra: Record<string, unknown> = {}): MessageWithParts => ({
  info: {
    id,
    sessionID: "ses_1",
    role: "user",
    agent: "plan",
    model: { providerID: "p", modelID: "m" },
    time: { created: 1 },
  } as any,
  parts: [{ id: `prt_${id}`, messageID: id, sessionID: "ses_1", type: "text", text, ...extra } as any],
})
const reply = (id: string, parentID: string, text: string, extra: Record<string, unknown> = {}): MessageWithParts => ({
  info: { id, sessionID: "ses_1", role: "assistant", parentID, time: { created: 1 }, ...extra } as any,
  parts: text ? [{ id: `prt_${id}`, messageID: id, sessionID: "ses_1", type: "text", text } as any] : [],
})

class FakeEngine implements EngineApi {
  sessions: Session[] = [session("ses_1", NOW, NOW - 10)]
  conversation: MessageWithParts[] = []
  statuses: Record<string, SessionStatus> = {}
  receipts = new Map<string, Receipt>()
  prompts: Parameters<EngineApi["promptAsync"]>[0][] = []
  promptStatus = 202
  reads = 0
  onRead: (() => void) | undefined
  receiptFailure = false

  async listSessions() {
    return this.sessions
  }
  async messages() {
    this.reads += 1
    const snapshot = structuredClone(this.conversation)
    this.onRead?.()
    return { messages: snapshot, complete: snapshot.length < 1000 }
  }
  async status() {
    return this.statuses
  }
  async receipt(_sessionId: string, messageId: string) {
    if (this.receiptFailure) throw new Error("down")
    return this.receipts.get(messageId)
  }
  async promptAsync(input: Parameters<EngineApi["promptAsync"]>[0]) {
    this.prompts.push(input)
    return this.promptStatus
  }
}

class FakeEvents implements EngineEvents {
  private handlers = new Map<string, Set<(event: any) => void>>()
  on<Type extends Event["type"]>(type: Type, handler: (event: Extract<Event, { type: Type }>) => void) {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler as (event: any) => void)
    this.handlers.set(type, set)
    return () => set.delete(handler as (event: any) => void)
  }
  emit(event: { type: string; properties: Record<string, unknown> }) {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event)
  }
}

function setup() {
  const engine = new FakeEngine()
  const events = new FakeEvents()
  let now = NOW
  const backend = new MimoBackend(engine, events, () => now)
  return { engine, events, backend, advance: (ms: number) => (now += ms) }
}

describe("phone backend", () => {
  test("lists root sessions in the local list order", async () => {
    const { engine, backend } = setup()
    engine.sessions = [
      session("ses_old", NOW - 2 * DAY, NOW - 3 * DAY),
      session("ses_a", NOW - 1000, NOW - 5000),
      session("ses_b", NOW - 2000, NOW - 100),
      session("ses_child", NOW, NOW, { parentID: "ses_a" }),
    ]
    expect((await backend.listSessions()).map((s) => s.id)).toEqual(["ses_b", "ses_a", "ses_old"])
  })

  test("a session outside the list has no snapshot", async () => {
    const { backend } = setup()
    expect(await backend.snapshot("ses_other")).toBeUndefined()
  })

  test("the snapshot carries only real conversation text, with turns from receipts", async () => {
    const { engine, backend } = setup()
    engine.conversation = [
      user("msg_01", "hello"),
      reply("msg_02", "msg_01", "Working"),
      reply("msg_03", "msg_01", "Done."),
      { info: user("msg_04", "").info, parts: [{ id: "prt_c", type: "compaction" } as any] },
      reply("msg_05", "msg_04", "summary text", { summary: true }),
      user("msg_06", "context", { synthetic: true }),
      user("msg_07", "next"),
      reply("msg_08", "msg_07", ""),
    ]
    engine.receipts.set("msg_01", { state: "settled", outcome: "success" })
    engine.receipts.set("msg_06", { state: "settled", outcome: "assistant_error" })
    engine.receipts.set("msg_07", { state: "claimed" })
    engine.statuses = { ses_1: { type: "busy" } }
    const snapshot = (await backend.snapshot("ses_1"))!
    expect(snapshot.phase).toBe("running")
    expect(snapshot.title).toBe("Title ses_1")
    expect(snapshot.parts.map((p) => [p.messageId, p.role, p.turnId, p.text])).toEqual([
      ["msg_01", "user", "msg_01", "hello"],
      ["msg_02", "assistant", "msg_01", "Working"],
      ["msg_03", "assistant", "msg_01", "Done."],
      ["msg_07", "user", "msg_07", "next"],
    ])
    // One turn per prompt, paired with its last reply; a compaction trigger is not a turn.
    // A prompt without any reply yet (msg_06) has no turn to report.
    expect(snapshot.turns).toEqual([
      { inputMessageId: "msg_01", assistantMessageId: "msg_03", phase: "completed" },
      { inputMessageId: "msg_07", assistantMessageId: "msg_08", phase: "running" },
    ])
  })

  test("receipt outcomes map to turn phases and unknown stays unknown", async () => {
    const { engine, backend } = setup()
    const cases: [Receipt | undefined, string][] = [
      [{ state: "accepted" }, "running"],
      [{ state: "settled", outcome: "assistant_error" }, "failed"],
      [{ state: "cancelled", outcome: "interrupted" }, "cancelled"],
      [{ state: "cancelled", outcome: "never_ran" }, "cancelled"],
      [{ state: "rejected" }, "unknown"],
      [undefined, "unknown"],
    ]
    engine.conversation = cases.flatMap((_, i) => [user(`msg_${i}a`, "q"), reply(`msg_${i}b`, `msg_${i}a`, "a")])
    cases.forEach(([receipt], i) => receipt && engine.receipts.set(`msg_${i}a`, receipt))
    const snapshot = (await backend.snapshot("ses_1"))!
    expect(snapshot.turns.map((t) => t.phase)).toEqual(cases.map(([, phase]) => phase) as never)
    expect(snapshot.phase).toBe("idle")
  })

  test("streamed text is appended only to parts the mirror saw being created", async () => {
    const { engine, events, backend } = setup()
    engine.conversation = [user("msg_01", "hi"), reply("msg_02", "msg_01", "")]
    engine.conversation[1].parts = [
      { id: "prt_old", messageID: "msg_02", sessionID: "ses_1", type: "text", text: "" } as any,
    ]
    await backend.snapshot("ses_1")
    // Already streaming when loaded: its deltas cannot be placed, so the stored text stays.
    events.emit({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_02", partID: "prt_old", field: "text", delta: "lost" },
    })
    // Created after the load: deltas build it up.
    const fresh = { id: "prt_new", messageID: "msg_02", sessionID: "ses_1", type: "text", text: "" }
    events.emit({ type: "message.part.updated", properties: { sessionID: "ses_1", part: fresh, time: 1 } })
    for (const delta of ["Hel", "lo"]) {
      events.emit({
        type: "message.part.delta",
        properties: { sessionID: "ses_1", messageID: "msg_02", partID: "prt_new", field: "text", delta },
      })
    }
    let snapshot = (await backend.snapshot("ses_1"))!
    expect(snapshot.parts.filter((p) => p.messageId === "msg_02").map((p) => [p.partId, p.text])).toEqual([
      ["prt_new", "Hello"],
      ["prt_old", ""],
    ])
    // The finished part replaces whatever was there.
    events.emit({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_old", messageID: "msg_02", sessionID: "ses_1", type: "text", text: "full text" },
        time: 2,
      },
    })
    snapshot = (await backend.snapshot("ses_1"))!
    expect(snapshot.parts.find((p) => p.partId === "prt_old")!.text).toBe("full text")
    expect(engine.reads).toBe(1)
  })

  test("a structural change during a load is not lost", async () => {
    const { engine, events, backend } = setup()
    engine.conversation = [user("msg_01", "hi")]
    engine.onRead = () => {
      engine.onRead = undefined
      // Arrives while the first read is in flight and may or may not be in it.
      engine.conversation.push(user("msg_02", "second"))
      events.emit({ type: "message.updated", properties: { sessionID: "ses_1", info: engine.conversation[1].info } })
    }
    const snapshot = (await backend.snapshot("ses_1"))!
    expect(engine.reads).toBe(2)
    expect(snapshot.parts.map((p) => p.messageId)).toEqual(["msg_01", "msg_02"])
  })

  test("a conversation the engine cut off is marked incomplete", async () => {
    const { engine, backend } = setup()
    engine.messages = async () => ({ messages: [user("msg_01", "hi")], complete: false })
    expect((await backend.snapshot("ses_1"))!.complete).toBe(false)
  })

  test("receipt events update turn phases and notify watchers", async () => {
    const { engine, events, backend } = setup()
    engine.conversation = [user("msg_01", "hi"), reply("msg_02", "msg_01", "")]
    engine.receipts.set("msg_01", { state: "claimed" })
    expect((await backend.snapshot("ses_1"))!.turns[0].phase).toBe("running")
    const seen: (string | undefined)[] = []
    backend.watch((id) => seen.push(id))
    events.emit({
      type: "session.receipt.updated",
      properties: {
        sessionID: "ses_1",
        agentID: "main",
        receiptId: "r",
        state: "settled",
        outcome: "success",
        inputMessageID: "msg_01",
        epoch: 1,
      },
    })
    expect(seen).toEqual(["ses_1"])
    engine.receipts.clear()
    expect((await backend.snapshot("ses_1"))!.turns[0].phase).toBe("completed")
  })

  test("submit continues with the session's agent and model and maps the engine answer", async () => {
    const { engine, backend } = setup()
    engine.conversation = [user("msg_01", "hi")]
    const id = backend.newMessageId()
    expect(id).toMatch(/^msg_/)
    expect(await backend.submit("ses_1", id, "from phone")).toEqual({ kind: "accepted" })
    expect(engine.prompts[0]).toMatchObject({
      sessionID: "ses_1",
      messageID: id,
      agent: "plan",
      model: { providerID: "p", modelID: "m" },
      parts: [{ type: "text", text: "from phone" }],
    })
    engine.promptStatus = 429
    expect(await backend.submit("ses_1", backend.newMessageId(), "x")).toEqual({ kind: "rejected", reason: "busy" })
    engine.promptStatus = 400
    expect(await backend.submit("ses_1", backend.newMessageId(), "x")).toEqual({ kind: "rejected", reason: "invalid" })
    engine.promptStatus = 500
    expect(await backend.submit("ses_1", backend.newMessageId(), "x")).toEqual({ kind: "unknown" })
    engine.promptAsync = async () => {
      throw new Error("transport")
    }
    expect(await backend.submit("ses_1", backend.newMessageId(), "x")).toEqual({ kind: "unknown" })
  })

  test("the phone gets a bounded share of the prompt rate", async () => {
    const { engine, backend, advance } = setup()
    for (let i = 0; i < 6; i++)
      expect((await backend.submit("ses_1", backend.newMessageId(), "x")).kind).toBe("accepted")
    expect(await backend.submit("ses_1", backend.newMessageId(), "x")).toEqual({ kind: "rejected", reason: "busy" })
    expect(engine.prompts.length).toBe(6)
    advance(60_000)
    expect((await backend.submit("ses_1", backend.newMessageId(), "x")).kind).toBe("accepted")
  })

  test("lookup is read-only and tells admitted, absent and unknown apart", async () => {
    const { engine, backend } = setup()
    engine.receipts.set("msg_01", { state: "accepted" })
    expect(await backend.lookup("ses_1", "msg_01")).toEqual({ kind: "admitted" })
    expect(await backend.lookup("ses_1", "msg_02")).toEqual({ kind: "absent" })
    engine.receiptFailure = true
    expect(await backend.lookup("ses_1", "msg_01")).toEqual({ kind: "unknown" })
    expect(engine.prompts).toEqual([])
  })

  test("session list changes invalidate the cached list and notify the catalog", async () => {
    const { engine, events, backend } = setup()
    await backend.listSessions()
    const seen: (string | undefined)[] = []
    backend.watch((id) => seen.push(id))
    engine.sessions = [...engine.sessions, session("ses_2", NOW + 1, NOW + 1)]
    events.emit({ type: "session.created", properties: { sessionID: "ses_2", info: engine.sessions[1] } })
    expect(seen).toEqual([undefined])
    expect((await backend.listSessions()).map((s) => s.id)).toEqual(["ses_2", "ses_1"])
  })
})
