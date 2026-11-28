import { describe, expect, test } from "bun:test"
import { ControlChannel } from "../src/control"
import { HeartbeatRuntime } from "../src/heartbeat"
import { BusSocket, BusCommandError } from "../src/bus"
import { wsDial, type Dial } from "../src/socket"
import { harness } from "./helpers"

async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

describe("control channel", () => {
  test("resolves with the service epoch and a new attach gets a new epoch", async () => {
    using h = await harness()
    await h.register()
    const closed: string[] = []
    const first = new ControlChannel(h.http, () => h.service.origin, wsDial, new HeartbeatRuntime(), { onClosed: (r) => closed.push(r) })
    expect(await first.open()).toBe(1)
    first.close()
    // Closing really ends the service side of the lease socket.
    await until(() => h.service.control === undefined)
    const second = new ControlChannel(h.http, () => h.service.origin, wsDial, new HeartbeatRuntime(), { onClosed: (r) => closed.push(r) })
    expect(await second.open()).toBe(2)
    expect(second.epoch).toBe(2)
    second.close()
    expect(closed).toEqual(["closed_by_client", "closed_by_client"])
  })

  test("the handshake is signed for GET /api/connect/control with the device id", async () => {
    using h = await harness()
    await h.register()
    h.state.deviceId = crypto.randomUUID()
    const control = new ControlChannel(h.http, () => h.service.origin, wsDial, new HeartbeatRuntime(), { onClosed: () => {} })
    await expect(control.open()).rejects.toThrow()
  })
})

describe("control channel heartbeat (R60)", () => {
  test("each confirmed probe renews the lease; the client sends nothing but pongs", async () => {
    using h = await harness()
    await h.register()
    const closed: string[] = []
    const control = new ControlChannel(h.http, () => h.service.origin, wsDial, new HeartbeatRuntime(), {
      onClosed: (r) => closed.push(r),
    })
    await control.open()
    const socket = h.service.control!
    expect(h.service.ping(socket)).toBe(1)
    await until(() => h.service.renewals.length === 1)
    expect(h.service.ping(socket)).toBe(2)
    await until(() => h.service.renewals.length === 2)
    const sent = h.service.frames.filter((f) => f.path === "/api/connect/control").map((f) => f.frame.type)
    expect(sent).toEqual(["heartbeat-pong", "heartbeat-pong"])
    expect(closed).toEqual([])
    control.close()
  })

  test("a lease that runs out without a confirmation ends the generation", async () => {
    using h = await harness()
    await h.register()
    let skew = 0
    const closed: string[] = []
    const control = new ControlChannel(
      h.http,
      () => h.service.origin,
      wsDial,
      new HeartbeatRuntime(),
      { onClosed: (r) => closed.push(r) },
      () => performance.now() + skew,
    )
    await control.open()
    skew = 75_000
    await until(() => closed.length === 1)
    expect(closed).toEqual(["lease_expired"])
  })

  test("a 101 that does not echo the heartbeat is not a connection", async () => {
    using h = await harness()
    await h.register()
    h.service.echoHeartbeat = false
    const control = new ControlChannel(h.http, () => h.service.origin, wsDial, new HeartbeatRuntime(), {
      onClosed: () => {},
    })
    await expect(control.open()).rejects.toThrow("handshake not accepted")
  })

  test("a refused upgrade feeds the service cooldown", async () => {
    using h = await harness()
    await h.register()
    h.service.rejectUpgrade = [503, "7"]
    const control = new ControlChannel(h.http, () => h.service.origin, wsDial, new HeartbeatRuntime(), {
      onClosed: () => {},
    })
    await expect(control.open()).rejects.toMatchObject({ status: 503 })
    expect(h.http.cooldownRemainingMs()).toBeGreaterThan(6_000)
  })
})

describe("bus socket", () => {
  async function busFor(h: Awaited<ReturnType<typeof harness>>, now?: () => number, dial: Dial = wsDial) {
    const events = {
      publications: [] as { channel: string; data: Record<string, unknown> }[],
      unsubscribed: [] as { channel: string; code: number }[],
      closed: [] as string[],
    }
    const bus = await BusSocket.open(
      h.http,
      h.service.origin,
      dial,
      {
        publication: (channel, data) => events.publications.push({ channel, data }),
        unsubscribed: (channel, code) => events.unsubscribed.push({ channel, code }),
        closed: (reason) => events.closed.push(reason),
      },
      now,
    )
    return { bus, events }
  }

  async function grantedBinding(h: Awaited<ReturnType<typeof harness>>) {
    const bindingId = crypto.randomUUID()
    h.service.bindings.set(bindingId, h.service.bindingView(bindingId))
    await h.api.publishGrant(bindingId, {
      connectionEpoch: 1,
      expectedVersion: 0,
      state: "active",
      scopes: ["sessions:list", "sessions:read"],
    })
    return bindingId
  }

  test("connect, subscribe cmd, receive a pushed command and publish a reply", async () => {
    using h = await harness()
    await h.register()
    h.service.epoch = 1
    const bindingId = await grantedBinding(h)
    const { bus, events } = await busFor(h)
    // The upgrade carries no service heartbeat header and the -cli subprotocol (the fake refuses otherwise).
    await bus.subscribe(`cmd:${bindingId}`)
    h.service.registrations.set(bindingId, { deviceGroupId: crypto.randomUUID(), connectionEpoch: 1, grantVersion: 1 })
    const requestId = crypto.randomUUID()
    h.service.phoneCommand(bindingId, { protocolVersion: 1, type: "sessions-list", requestId, grantVersion: 1 })
    await until(() => events.publications.length === 1)
    expect(events.publications[0]!.channel).toBe(`cmd:${bindingId}`)
    expect(events.publications[0]!.data).toMatchObject({ lane: "command", frame: { type: "request", operation: "sessions-list" } })
    await bus.publish(`rep:${bindingId}:${requestId}`, { lane: "command", frame: { type: "sessions-page" } })
    expect(h.service.published).toEqual([
      { channel: `rep:${bindingId}:${requestId}`, data: { lane: "command", frame: { type: "sessions-page" } } },
    ])
    bus.close()
    expect(events.closed).toEqual(["closed_by_client"])
  })

  test("publishes only on a matching ACK with a publish result object", async () => {
    using h = await harness()
    await h.register()
    let id: unknown
    let receive!: (frame: Record<string, unknown>) => void
    const dial: Dial = async ({ protocol, handlers }) => {
      receive = handlers.onFrame
      return {
        protocol,
        send(frame) {
          if ("connect" in frame) receive({ id: frame.id, connect: { client: "test", ping: 25, pong: true } })
          if ("publish" in frame) id = frame.id
        },
        close() {},
      }
    }
    const { bus } = await busFor(h, undefined, dial)
    try {
      const data = { lane: "command", frame: { type: "sessions-page" } }
      for (const result of [{}, { subscribe: {} }, { publish: null }, { publish: [] }, { publish: true }]) {
        const publish = bus.publish("rep:binding:request", data)
        receive({ id, ...result })
        await expect(publish).rejects.toThrow("invalid_publish")
      }

      let acknowledged = false
      const publish = bus.publish("rep:binding:request", data).then(() => {
        acknowledged = true
      })
      receive({ id: Number(id) - 1, publish: {} })
      await Bun.sleep(0)
      expect(acknowledged).toBe(false)
      receive({ id, publish: { futureField: true } })
      await publish
      expect(acknowledged).toBe(true)
    } finally {
      bus.close()
    }
  })

  test("the service ping is answered with an empty command", async () => {
    using h = await harness()
    await h.register()
    h.service.epoch = 1
    const bindingId = await grantedBinding(h)
    const { bus } = await busFor(h)
    await bus.subscribe(`cmd:${bindingId}`)
    h.service.busPing()
    await until(() => h.service.frames.some((f) => f.path === "/api/connect/bus" && Object.keys(f.frame).length === 0))
    bus.close()
  })

  test("a refused publish rejects with the service code and an unauthorized subscribe is refused", async () => {
    using h = await harness()
    await h.register()
    h.service.epoch = 1
    const bindingId = await grantedBinding(h)
    const { bus } = await busFor(h)
    await expect(bus.subscribe(`cmd:${crypto.randomUUID()}`)).rejects.toMatchObject({ code: 103 })
    h.service.refusePublish = 106
    const refused = bus.publish(`rep:${bindingId}:${crypto.randomUUID()}`, { lane: "text", frame: {} })
    await expect(refused).rejects.toBeInstanceOf(BusCommandError)
    await expect(bus.publish(`rep:${bindingId}:x`, { lane: "text", frame: { text: "x".repeat(270_000) } })).rejects.toMatchObject({ code: 106 })
    bus.close()
  })

  test("a withdrawn subscription is reported with its code", async () => {
    using h = await harness()
    await h.register()
    h.service.epoch = 1
    const bindingId = await grantedBinding(h)
    const { bus, events } = await busFor(h)
    await bus.subscribe(`cmd:${bindingId}`)
    h.service.phoneRevokes(bindingId)
    await until(() => events.unsubscribed.length === 1)
    expect(events.unsubscribed[0]).toEqual({ channel: `cmd:${bindingId}`, code: 2001 })
    bus.close()
  })

  test("a bus silent for longer than ping + 20 s is closed", async () => {
    using h = await harness()
    await h.register()
    let skew = 0
    const { events } = await busFor(h, () => performance.now() + skew)
    skew = 46_000
    await until(() => events.closed.length === 1)
    expect(events.closed).toEqual(["ping_timeout"])
  })
})
