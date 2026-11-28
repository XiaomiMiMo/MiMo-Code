import { describe, expect, test } from "bun:test"
import { BindingView, GrantView } from "../src/api"
import { BusCommandError, BusSocket } from "../src/bus"
import { ControlChannel } from "../src/control"
import { Dispatcher } from "../src/dispatcher"
import { DeviceGroup, type GroupDiagnostic, type GroupGrant } from "../src/group"
import { HeartbeatRuntime } from "../src/heartbeat"
import { withinDepth } from "../src/json"
import { wsDial, type Dial, type FrameSocket, type SocketHandlers } from "../src/socket"
import { StateFile } from "../src/state"
import { Submissions } from "../src/submissions"
import { FakeBackend, MemorySecrets } from "./doubles"
import { harness } from "./helpers"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

function nested(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: 1 }
  for (let i = 1; i < depth; i++) node = { child: node }
  return node
}

describe("device-group reply lifecycle", () => {
  async function replyGroup(dialGate?: Promise<void>) {
    const h = await harness()
    await h.register()
    h.service.epoch = 1
    const bindingId = crypto.randomUUID()
    h.service.bindings.set(bindingId, h.service.bindingView(bindingId))
    await h.api.publishGrant(bindingId, {
      connectionEpoch: 1,
      expectedVersion: 0,
      state: "active",
      scopes: ["sessions:list", "sessions:read"],
    })
    const dir = await mkdtemp(path.join(tmpdir(), "reply-group-"))
    const backend = new FakeBackend()
    backend.snapshots.set("ses_1", { title: "First", phase: "idle", parts: [], turns: [] })
    const submissions = new Submissions(backend, new StateFile(path.join(dir, "state"), new MemorySecrets()))
    const publish: Record<string, unknown>[] = []
    const commands: string[] = []
    const closed: string[] = []
    const ended: string[] = []
    const dialStarted = Promise.withResolvers<void>()
    let handlers!: SocketHandlers
    const dial: Dial = async (input) => {
      handlers = input.handlers
      dialStarted.resolve()
      await dialGate
      return {
        protocol: input.protocol,
        send(frame) {
          if ("connect" in frame) {
            commands.push("connect")
            handlers.onFrame({ id: frame.id, connect: { client: "c1", ping: 25, pong: true } })
          } else if ("subscribe" in frame) {
            commands.push("subscribe")
            handlers.onFrame({ id: frame.id, subscribe: {} })
          } else if ("publish" in frame) {
            commands.push("publish")
            publish.push(frame)
          }
        },
        close(code, reason) {
          closed.push(reason ?? "")
          handlers.onClose(code ?? 1000, reason ?? "")
        },
      }
    }
    const context = { api: h.api, http: h.http, origin: () => h.service.origin, dial, backend, submissions }
    const grant: GroupGrant = { bindingId, grantVersion: 1, connectionEpoch: 1, scopes: ["sessions:list", "sessions:read"] }
    const group = new DeviceGroup(context, grant, (end) => ended.push(end.reason))
    let offset = 0
    function receive(frame: Record<string, unknown>) {
      handlers.onFrame({ push: { channel: `cmd:${bindingId}`, pub: { offset: ++offset, data: { lane: "command", frame } } } })
    }
    return {
      group,
      publish,
      commands,
      closed,
      ended,
      dialStarted: dialStarted.promise,
      registered: () => h.service.registrations.has(bindingId),
      request(operation: string, fields: Record<string, unknown> = {}) {
        const ids = { requestId: crypto.randomUUID(), dispatchId: crypto.randomUUID() }
        receive({
          type: "request",
          protocolVersion: 1,
          bindingId,
          grantVersion: 1,
          connectionEpoch: 1,
          deviceGroupId: group.deviceGroupId,
          operation,
          ...ids,
          ...fields,
        })
        return { ...ids, channel: `rep:${bindingId}:${ids.requestId}` }
      },
      ack(index: number, result: Record<string, unknown> = { publish: {} }) {
        handlers.onFrame({ id: publish[index].id, ...result })
      },
      async untilPublished(count: number, ms = 2000) {
        const end = Date.now() + ms
        while (publish.length < count) {
          if (Date.now() > end) throw new Error("timed out waiting for publication")
          await Bun.sleep(5)
        }
      },
      async [Symbol.asyncDispose]() {
        group.close()
        h[Symbol.dispose]()
        await rm(dir, { recursive: true, force: true })
      },
    }
  }
  test("serializes per-request replies across the group and never sends a retired reading's state", async () => {
    await using s = await replyGroup()
    await s.group.open()
    const reading = s.request("subscribe-session", { sessionId: "ses_1" })
    await s.untilPublished(1)
    const stop = s.request("unsubscribe", { subscriptionRequestId: reading.requestId })
    const another = s.request("unsubscribe", { subscriptionRequestId: crypto.randomUUID() })
    expect(s.publish).toHaveLength(1)
    expect(s.publish[0]).toMatchObject({ publish: { channel: reading.channel, data: { lane: "text" } } })

    for (const [index, request] of [stop, another].entries()) {
      s.ack(index)
      await s.untilPublished(index + 2)
      expect(s.publish).toHaveLength(index + 2)
      expect(s.publish[index + 1]).toMatchObject({
        publish: { channel: request.channel, data: { lane: "command", frame: { type: "unsubscribed" } } },
      })
    }
    s.ack(2)
    await Bun.sleep(0)
    expect(s.publish).toHaveLength(3)
    expect(s.group.ready).toBe(true)
  })

  test("a malformed publish ACK retires the group and drops queued replies", async () => {
    await using s = await replyGroup()
    await s.group.open()
    s.request("subscribe-session", { sessionId: "ses_1" })
    await s.untilPublished(1)
    s.request("unsubscribe", { subscriptionRequestId: crypto.randomUUID() })
    expect(s.publish).toHaveLength(1)
    s.ack(0, {})
    await Bun.sleep(0)
    expect(s.ended).toEqual(["publish_invalid_publish"])
    expect(s.group.ready).toBe(false)
    expect(s.closed).toHaveLength(1)
    s.ack(0)
    s.request("unsubscribe", { subscriptionRequestId: crypto.randomUUID() })
    await Bun.sleep(0)
    expect(s.publish).toHaveLength(1)
  })

  test("reply backlog is bounded and late ACKs cannot drain a retired group", async () => {
    await using s = await replyGroup()
    await s.group.open()
    for (let i = 0; i < 16; i++) s.request("unsubscribe", { subscriptionRequestId: crypto.randomUUID() })
    expect(s.publish).toHaveLength(1)
    expect(s.group.ready).toBe(true)
    s.request("unsubscribe", { subscriptionRequestId: crypto.randomUUID() })
    expect(s.ended).toEqual(["publish_queue_full"])
    expect(s.group.ready).toBe(false)
    s.ack(0)
    await Bun.sleep(0)
    expect(s.publish).toHaveLength(1)
    expect(s.closed).toHaveLength(1)
  })

  test("closes a socket returned by an in-flight dial after group retirement", async () => {
    const gate = Promise.withResolvers<void>()
    await using s = await replyGroup(gate.promise)
    const opening = s.group.open()
    await s.dialStarted
    s.group.close()
    gate.resolve()
    await expect(opening).rejects.toThrow()
    expect(s.closed).toHaveLength(1)
    expect(s.commands).toEqual([])
    expect(s.registered()).toBe(false)
    expect(s.group.ready).toBe(false)
    expect(s.ended).toEqual([])
  })
})

describe("forward compatibility (connect-protocol R63)", () => {
  test("withinDepth counts the root object as level 1", () => {
    expect(withinDepth(nested(16), 16)).toBe(true)
    expect(withinDepth(nested(17), 16)).toBe(false)
    expect(withinDepth(nested(20), 20)).toBe(true)
    expect(withinDepth(nested(21), 20)).toBe(false)
  })

  test("HTTP responses tolerate unknown fields, unknown scopes, and reject Desktop identity fields or unknown enums", async () => {
    const id = crypto.randomUUID()
    const baseBinding = {
      bindingId: id,
      phoneId: crypto.randomUUID(),
      connectorId: crypto.randomUUID(),
      connectorKind: "cli",
      connectorName: "Claude Code",
      state: "active",
      relayFence: "complete",
      revocationVersion: 0,
    }
    expect(BindingView.parse({ ...baseBinding, futureFlag: true, nested: { a: 1 } }).bindingId).toBe(id)
    // Forbidden Desktop view fields in CLI view must still be rejected.
    expect(() => BindingView.parse({ ...baseBinding, desktopId: crypto.randomUUID() })).toThrow()
    expect(() => BindingView.parse({ ...baseBinding, desktopName: "My Mac" })).toThrow()
    // Unregistered critical enum fails closed.
    expect(() => BindingView.parse({ ...baseBinding, state: "paused" })).toThrow()
    expect(() => BindingView.parse({ ...baseBinding, relayFence: "draining" })).toThrow()

    const baseGrant = {
      protocolVersion: 1,
      targetKind: "cli",
      bindingId: id,
      connectorId: crypto.randomUUID(),
      grantVersion: 1,
      revocationVersion: 0,
      connectionEpoch: 1,
      state: "active",
      scopes: ["sessions:list", "sessions:read", "future:feature"],
      relayFence: "complete",
      futureMeta: "ignored",
    }
    // Unregistered scopes are treated as ungranted without rejecting known scopes.
    expect(GrantView.parse(baseGrant).scopes).toEqual(["sessions:list", "sessions:read"])
    expect(() => GrantView.parse({ ...baseGrant, desktopId: crypto.randomUUID() })).toThrow()
  })

  test("HTTP responses with unknown fields succeed, over-deep responses fail as too_deep, and unknown error codes are transient", async () => {
    using h = await harness()
    await h.register()
    const addField = (field: string, value: unknown) => async (response: Response) => {
      const envelope = (await response.clone().json()) as { data: Record<string, unknown> }
      envelope.data[field] = value
      return new Response(JSON.stringify(envelope), { status: response.status, headers: response.headers })
    }
    h.service.tamper.set("/api/connect/device-challenges", addField("futureHint", { x: 1 }))
    h.service.tamper.set("/api/connect/pairing/challenges", addField("futureField", "ok"))
    const challenge = await h.api.createPairingCode(1)
    expect(challenge.code).toMatch(/^\d{4}$/)

    // Over-deep HTTP envelope (>16 levels) fails only that request.
    h.service.tamper.set("/api/connect/pairing/challenges", addField("deep", nested(16)))
    await expect(h.api.createPairingCode(1)).rejects.toMatchObject({ code: "too_deep" })

    // Unregistered HTTP error code is transient and respects Retry-After without counting as account rejection.
    h.service.failNext.set("/api/connect/pairing/challenges", [403, "future_gate_hold", "2"])
    await expect(h.api.createPairingCode(1)).rejects.toMatchObject({
      code: "future_gate_hold",
      status: 403,
      transient: true,
      unregistered: true,
    })
    expect(h.http.cooldownRemainingMs()).toBeGreaterThan(1_000)
  })

  test("control channel tolerates extra ready fields, drops unknown control types and over-deep frames without renewing liveness", async () => {
    using h = await harness()
    await h.register()
    let now = 1_000
    const heartbeats = new HeartbeatRuntime(() => now)
    const closed: string[] = []
    const ignored: string[] = []
    const control = new ControlChannel(
      h.http,
      () => h.service.origin,
      wsDial,
      heartbeats,
      {
        onClosed: (reason) => closed.push(reason),
        onIgnored: (category) => ignored.push(category),
      },
      () => now,
    )
    await control.open()
    // Advance 20s in normal ticks, then send unregistered & over-deep frames.
    // If those frames wrongly refreshed liveness, advancing 25s more would NOT expire the 45s watchdog.
    for (let i = 0; i < 80; i++) {
      now += 250
      heartbeats.tick()
    }
    h.service.control!.send(JSON.stringify({ protocolVersion: 1, type: "future-notice", payload: 1 }))
    h.service.control!.send(JSON.stringify({ protocolVersion: 1, type: "future-notice-2" }))
    h.service.control!.send(JSON.stringify({ protocolVersion: 1, type: "ready", deep: nested(16) }))
    await Bun.sleep(50)
    expect(closed).toEqual([])
    expect(ignored).toEqual(["unknown_type", "too_deep"])

    for (let i = 0; i < 100; i++) {
      now += 250
      heartbeats.tick()
    }
    expect(closed).toEqual(["heartbeat_watchdog_timeout"])
  })

  test("bus drops unknown pushes, unknown lanes and over-deep messages without closing, and rebuilds on publish 104/106", async () => {
    using h = await harness()
    await h.register()
    let deliver!: (frame: Record<string, unknown>) => void
    let publishCode: number | undefined
    const sent: Record<string, unknown>[] = []
    const fakeDial: Dial = async (input) => {
      deliver = input.handlers.onFrame
      const socket: FrameSocket = {
        protocol: input.protocol,
        send(frame) {
          sent.push(frame)
          if ("connect" in frame) queueMicrotask(() => deliver({ id: frame.id, connect: { client: "c1", ping: 25, pong: true, extra: 1 } }))
          else if ("subscribe" in frame) queueMicrotask(() => deliver({ id: frame.id, subscribe: { extra: true } }))
          else if ("publish" in frame) {
            queueMicrotask(() =>
              deliver(
                publishCode !== undefined
                  ? { id: frame.id, error: { code: publishCode, message: "err", temporary: publishCode === 106 } }
                  : { id: frame.id, publish: {} },
              ),
            )
          }
        },
        close() {},
      }
      return socket
    }
    const busIgnored: string[] = []
    const groupIgnored: GroupDiagnostic[] = []
    const ended: string[] = []
    const bindingId = crypto.randomUUID()
    h.service.epoch = 1
    h.service.bindings.set(bindingId, h.service.bindingView(bindingId))
    await h.api.publishGrant(bindingId, {
      connectionEpoch: 1,
      expectedVersion: 0,
      state: "active",
      scopes: ["sessions:list", "sessions:read"],
    })
    const dir = await mkdtemp(path.join(tmpdir(), "r63-group-"))
    try {
      const backend = new FakeBackend()
      const submissions = new Submissions(backend, new StateFile(path.join(dir, "state"), new MemorySecrets()))
      const group = new DeviceGroup(
        {
          api: h.api,
          http: h.http,
          origin: () => h.service.origin,
          dial: fakeDial,
          backend,
          submissions,
          onIgnored: (c) => groupIgnored.push(c),
        },
        { bindingId, grantVersion: 1, connectionEpoch: 1, scopes: ["sessions:list", "sessions:read"] },
        (end) => ended.push(end.reason),
      )
      await group.open()

      // Unknown push kind on bus, extra key on push, unknown lane on cmd, over-deep frame: group stays ready.
      deliver({ push: { channel: `cmd:${bindingId}`, futurePush: {} }, extraRoot: 1 })
      deliver({ push: { channel: `cmd:${bindingId}`, pub: { offset: 1, data: { lane: "future-lane", frame: { type: "request" }, extra: 1 } } } })
      deliver({ push: { channel: `cmd:${bindingId}`, pub: { offset: 2, data: { lane: "command", frame: nested(17) } } } })
      expect(group.ready).toBe(true)
      expect(ended).toEqual([])
      expect(groupIgnored).toEqual(["unknown_push", "unknown_lane", "too_deep"])

      // BusSocket itself reports unknown_push and too_deep (>20 levels) once per connection without closing.
      const bus = await BusSocket.open(h.http, h.service.origin, fakeDial, {
        publication: () => {},
        unsubscribed: () => {},
        closed: () => {},
        ignored: (c) => busIgnored.push(c),
      })
      deliver({ push: { channel: "x", unknownKind: {} } })
      deliver({ push: { channel: "x", unknownKind2: {} } })
      deliver({ push: { deep: nested(20) } })
      expect(busIgnored).toEqual(["unknown_push", "too_deep"])
      publishCode = 104
      await expect(bus.publish("rep:x:y", { lane: "command", frame: {} })).rejects.toBeInstanceOf(BusCommandError)
      await expect(bus.publish("rep:x:y", { lane: "command", frame: {} })).rejects.toMatchObject({ code: 104 })
      publishCode = 106
      await expect(bus.publish("rep:x:y", { lane: "command", frame: {} })).rejects.toMatchObject({ code: 106, temporary: true })
      bus.close()
      group.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("catalog request with extra sessionId ignores it and never echoes sessionId in sessions-page", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "r63-disp-"))
    try {
      const backend = new FakeBackend()
      const submissions = new Submissions(backend, new StateFile(path.join(dir, "state"), new MemorySecrets()))
      const sent: Record<string, unknown>[] = []
      const scope = {
        bindingId: crypto.randomUUID(),
        deviceGroupId: crypto.randomUUID(),
        connectionEpoch: 1,
        grantVersion: 1,
        canSend: true,
      }
      const dispatcher = new Dispatcher(scope, backend, submissions, async (_lane, frame) => {
        sent.push(frame)
        return true
      })
      dispatcher.handle({
        ...scope,
        protocolVersion: 1,
        type: "request",
        operation: "sessions-list",
        requestId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        sessionId: "should-be-ignored",
        cursor: null,
        limit: 10,
      })
      await Bun.sleep(30)
      expect(sent).toHaveLength(1)
      expect(sent[0]!.type).toBe("sessions-page")
      expect(sent[0]).not.toHaveProperty("sessionId")
      dispatcher.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
