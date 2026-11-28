import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Lane } from "../src/api"
import { Dispatcher, type GroupScope, type Outbox } from "../src/dispatcher"
import type { Json } from "../src/json"
import { StateFile } from "../src/state"
import { Submissions } from "../src/submissions"
import { FakeBackend, MemorySecrets } from "./doubles"

const scope: GroupScope = {
  bindingId: "11111111-1111-4111-8111-111111111111",
  deviceGroupId: "22222222-2222-4222-8222-222222222222",
  connectionEpoch: 3,
  grantVersion: 2,
  canSend: true,
}

const { canSend: _canSend, ...wire } = scope

type Sent = { lane: Lane; frame: Record<string, any> }

async function setup(options: { canSend?: boolean; acknowledge?: Outbox } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "dispatch-"))
  const backend = new FakeBackend()
  backend.snapshots.set("ses_1", {
    title: "First",
    phase: "idle",
    parts: [{ messageId: "msg_u1", partId: "prt_1", role: "user", turnId: "msg_u1", text: "hi" }],
    turns: [],
  })
  const sent: Sent[] = []
  const open = { command: true, state: true, text: true }
  const submissions = new Submissions(backend, new StateFile(path.join(dir, "state"), new MemorySecrets()))
  const dispatcher = new Dispatcher(
    { ...scope, canSend: options.canSend ?? true },
    backend,
    submissions,
    async (lane, frame, signal) => {
      if (!open[lane]) return false
      sent.push({ lane, frame })
      return options.acknowledge ? options.acknowledge(lane, frame, signal) : true
    },
  )
  return {
    backend,
    sent,
    open,
    dispatcher,
    request(operation: string, fields: Record<string, Json> = {}) {
      const ids = { requestId: crypto.randomUUID(), dispatchId: crypto.randomUUID() }
      dispatcher.handle({
        protocolVersion: 1,
        type: "request",
        operation,
        bindingId: scope.bindingId,
        connectionEpoch: scope.connectionEpoch,
        deviceGroupId: scope.deviceGroupId,
        grantVersion: scope.grantVersion,
        ...ids,
        ...fields,
      })
      return ids
    },
    async until(predicate: () => boolean, ms = 2000) {
      const end = Date.now() + ms
      while (!predicate()) {
        if (Date.now() > end) throw new Error("timed out waiting")
        await Bun.sleep(5)
      }
    },
    async [Symbol.asyncDispose]() {
      dispatcher.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const TARGET_KEYS = [
  "bindingId",
  "connectionEpoch",
  "deviceGroupId",
  "dispatchId",
  "grantVersion",
  "protocolVersion",
  "requestId",
]

describe("dispatcher", () => {
  test("sessions-list answers a page that echoes the exact target", async () => {
    await using s = await setup()
    const ids = s.request("sessions-list", { cursor: null, limit: 50 })
    await s.until(() => s.sent.length === 1)
    const { lane, frame } = s.sent[0]
    expect(lane).toBe("command")
    expect(frame).toMatchObject({ ...wire, ...ids, protocolVersion: 1, type: "sessions-page", nextCursor: null })
    expect(frame.canSend).toBeUndefined()
    expect(Object.keys(frame).sort()).toEqual([...TARGET_KEYS, "entries", "nextCursor", "revision", "type"].sort())
    expect(frame.entries).toEqual([
      { sessionId: "ses_1", title: "First", updatedAt: new Date(1_700_000_000_000).toISOString() },
    ])
  })

  test("frames for another group or grant are ignored", async () => {
    await using s = await setup()
    s.request("sessions-list", { grantVersion: 9 })
    s.request("sessions-list", { deviceGroupId: crypto.randomUUID() })
    await Bun.sleep(30)
    expect(s.sent).toEqual([])
  })

  test("a bad cursor is a request error", async () => {
    await using s = await setup()
    s.request("sessions-list", { cursor: `${"a".repeat(10)}.${"b".repeat(43)}`, limit: 10 })
    await s.until(() => s.sent.length === 1)
    expect(s.sent[0].frame).toMatchObject({ type: "request-error", code: "invalid_cursor" })
  })

  test("sessions-watch reports the current revision at once and then only changes", async () => {
    await using s = await setup()
    s.request("sessions-watch", { revision: null })
    await s.until(() => s.sent.length === 1)
    expect(s.sent[0].frame).toMatchObject({ type: "sessions-changed" })
    expect(s.sent[0].frame.revision).toMatch(/^[a-f0-9]{64}$/)
    s.backend.changed()
    await Bun.sleep(260)
    expect(s.sent.length).toBe(1)
    s.backend.sessions = [...s.backend.sessions, { id: "ses_2", title: "Second", updatedAt: 1 }]
    s.backend.changed()
    await s.until(() => s.sent.length === 2)
    expect(s.sent[1].frame.revision).not.toBe(s.sent[0].frame.revision)
  })

  test("a watch whose source fails ends as source_unavailable", async () => {
    await using s = await setup()
    s.request("sessions-watch", { revision: null })
    await s.until(() => s.sent.length === 1)
    s.backend.listSessions = async () => {
      throw new Error("db closed")
    }
    s.backend.changed()
    await s.until(() => s.sent.length === 2)
    expect(s.sent[1].frame).toMatchObject({ type: "subscription-closed", code: "source_unavailable" })
  })

  test("subscribe-session publishes text before state with the session target", async () => {
    await using s = await setup()
    const ids = s.request("subscribe-session", { sessionId: "ses_1" })
    await s.until(() => s.sent.length === 2)
    expect(s.sent.map((x) => x.lane)).toEqual(["text", "state"])
    for (const { frame } of s.sent) {
      expect(frame).toMatchObject({
        ...ids,
        sessionId: "ses_1",
        desktopSessionId: "ses_1",
        sequence: 0,
        snapshot: true,
      })
    }
    expect(s.sent[0].frame.parts[0]).toMatchObject({ messageId: "msg_u1", role: "user", revision: 1 })
  })

  test("a reading waits for text ACK before state and for state ACK before its next refresh", async () => {
    const textAck = Promise.withResolvers<boolean>()
    const stateAck = Promise.withResolvers<boolean>()
    await using s = await setup({
      acknowledge: async (lane, frame) => {
        if (frame.sequence !== 0) return true
        if (lane === "text") return textAck.promise
        return stateAck.promise
      },
    })
    s.request("subscribe-session", { sessionId: "ses_1" })
    await s.until(() => s.sent.length >= 1)
    expect(s.sent.map(({ lane }) => lane)).toEqual(["text"])
    textAck.resolve(true)
    await s.until(() => s.sent.length >= 2)
    expect(s.sent.map(({ lane }) => lane)).toEqual(["text", "state"])

    const snapshot = s.backend.snapshots.get("ses_1")!
    s.backend.snapshots.set("ses_1", { ...snapshot, parts: [] })
    s.backend.changed("ses_1")
    await Bun.sleep(260)
    expect(s.sent).toHaveLength(2)
    stateAck.resolve(true)
    await s.until(() => s.sent.length >= 3)
    expect(s.sent[2]).toMatchObject({ lane: "text", frame: { sequence: 1, contentRevision: 2 } })
  })

  test("a catalog watch with an unacknowledged first reply retires rather than publishing again", async () => {
    const firstAck = Promise.withResolvers<boolean>()
    await using s = await setup({ acknowledge: () => firstAck.promise })
    s.request("sessions-watch")
    await s.until(() => s.sent.length === 1)
    s.backend.sessions = [...s.backend.sessions, { id: "ses_2", title: "Second", updatedAt: 1 }]
    s.backend.changed()
    await Bun.sleep(260)
    expect(s.sent).toHaveLength(1)
    firstAck.resolve(false)
    s.backend.changed()
    await Bun.sleep(260)
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].frame.type).toBe("sessions-changed")
  })

  test("updates are coalesced into the latest projection", async () => {
    await using s = await setup()
    s.request("subscribe-session", { sessionId: "ses_1" })
    await s.until(() => s.sent.length === 2)
    for (const text of ["hi!", "hi!!", "hi!!!"]) {
      s.backend.snapshots.set("ses_1", {
        ...s.backend.snapshots.get("ses_1")!,
        parts: [{ messageId: "msg_u1", partId: "prt_1", role: "user", turnId: "msg_u1", text }],
      })
      s.backend.changed("ses_1")
    }
    await s.until(() => s.sent.length === 3)
    await Bun.sleep(260)
    expect(s.sent.length).toBe(3)
    expect(s.sent[2]).toMatchObject({ lane: "text", frame: { sequence: 1, contentRevision: 2 } })
    expect(s.sent[2].frame.parts[0].text).toBe("hi!!!")
  })

  test("a session that is not listed is not_found before streaming and resync_required after", async () => {
    await using s = await setup()
    s.request("subscribe-session", { sessionId: "ses_missing" })
    await s.until(() => s.sent.length === 1)
    expect(s.sent[0].frame).toMatchObject({ type: "request-error", code: "not_found", sessionId: "ses_missing" })
    s.request("subscribe-session", { sessionId: "ses_1" })
    await s.until(() => s.sent.length === 3)
    s.backend.snapshots.delete("ses_1")
    s.backend.changed("ses_1")
    await s.until(() => s.sent.length === 4)
    expect(s.sent[3].frame).toMatchObject({ type: "subscription-closed", code: "resync_required" })
  })

  test("a session over budget fails closed with projection_too_large", async () => {
    await using s = await setup()
    s.backend.snapshots.set("ses_1", {
      title: "",
      phase: "idle",
      parts: Array.from({ length: 300 }, (_, i) => ({
        messageId: `m${i}`,
        partId: "p",
        role: "user" as const,
        turnId: `m${i}`,
        text: "x",
      })),
      turns: [],
    })
    s.request("subscribe-session", { sessionId: "ses_1" })
    await s.until(() => s.sent.length === 1)
    expect(s.sent[0].frame).toMatchObject({ type: "request-error", code: "projection_too_large" })
  })

  test("a frame the lane cannot carry restarts the stream instead of leaving a gap", async () => {
    await using s = await setup()
    s.request("subscribe-session", { sessionId: "ses_1" })
    await s.until(() => s.sent.length === 2)
    s.open.text = false
    s.backend.snapshots.set("ses_1", { ...s.backend.snapshots.get("ses_1")!, parts: [] })
    s.backend.changed("ses_1")
    await s.until(() => s.sent.length === 3)
    expect(s.sent[2].frame).toMatchObject({ type: "subscription-closed", code: "resync_required" })
  })

  test("unsubscribe retires the observation and is answered even when it is already gone", async () => {
    await using s = await setup()
    const reading = s.request("subscribe-session", { sessionId: "ses_1" })
    await s.until(() => s.sent.length === 2)
    s.request("unsubscribe", { subscriptionRequestId: reading.requestId })
    await s.until(() => s.sent.length === 3)
    expect(s.sent[2].frame).toMatchObject({ type: "unsubscribed", subscriptionRequestId: reading.requestId })
    s.backend.snapshots.set("ses_1", { ...s.backend.snapshots.get("ses_1")!, title: "Renamed" })
    s.backend.changed("ses_1")
    s.request("unsubscribe", { subscriptionRequestId: reading.requestId })
    await s.until(() => s.sent.length === 4)
    await Bun.sleep(260)
    expect(s.sent.length).toBe(4)
    expect(s.sent[3].frame.type).toBe("unsubscribed")
  })

  test("an observation the service closed publishes nothing more", async () => {
    await using s = await setup()
    const reading = s.request("subscribe-session", { sessionId: "ses_1" })
    await s.until(() => s.sent.length === 2)
    s.dispatcher.handle({ protocolVersion: 1, type: "subscription-closed", ...wire, ...reading, code: "cancelled" })
    s.backend.snapshots.set("ses_1", { ...s.backend.snapshots.get("ses_1")!, title: "Renamed" })
    s.backend.changed("ses_1")
    await Bun.sleep(260)
    expect(s.sent.length).toBe(2)
  })

  test("send answers accepted with the admitted user message and status repeats it without resubmitting", async () => {
    await using s = await setup()
    const send = s.request("send", { sessionId: "ses_1", text: "do it" })
    await s.until(() => s.sent.length === 1)
    expect(s.sent[0].frame).toMatchObject({
      ...send,
      type: "submission-result",
      sessionId: "ses_1",
      status: "accepted",
    })
    const messageId = s.sent[0].frame.messageId
    expect(s.backend.submits).toEqual([{ sessionId: "ses_1", messageId, text: "do it" }])
    s.dispatcher.handle({
      protocolVersion: 1,
      type: "request",
      operation: "submission-status",
      ...wire,
      requestId: send.requestId,
      dispatchId: crypto.randomUUID(),
      sessionId: "ses_1",
    })
    await s.until(() => s.sent.length === 2)
    expect(s.sent[1].frame).toMatchObject({ status: "accepted", messageId })
    expect(Object.keys(s.sent[1].frame).sort()).toEqual(
      [...TARGET_KEYS, "messageId", "sessionId", "status", "type"].sort(),
    )
    expect(s.backend.submits.length).toBe(1)
  })

  test("send without the send scope is rejected read-only and never reaches the agent", async () => {
    await using s = await setup({ canSend: false })
    s.request("send", { sessionId: "ses_1", text: "do it" })
    await s.until(() => s.sent.length === 1)
    expect(s.sent[0].frame).toMatchObject({ status: "rejected", reason: "read-only" })
    expect(s.backend.submits).toEqual([])
  })

  test("nothing is published after the group closes", async () => {
    await using s = await setup()
    s.request("subscribe-session", { sessionId: "ses_1" })
    await s.until(() => s.sent.length === 2)
    s.dispatcher.close()
    s.backend.changed("ses_1")
    s.request("sessions-list")
    await Bun.sleep(260)
    expect(s.sent.length).toBe(2)
  })
})
