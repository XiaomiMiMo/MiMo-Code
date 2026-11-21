import { describe, expect, test } from "bun:test"
import { ControlChannel } from "../src/control"
import { HeartbeatRuntime } from "../src/heartbeat"
import { ContentLane, type Fence } from "../src/lane"
import { wsDial } from "../src/socket"
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

describe("content lane", () => {
  async function laneFor(h: Awaited<ReturnType<typeof harness>>, onFence: (f: Fence) => Promise<void>) {
    await h.register()
    const control = new ControlChannel(h.http, () => h.service.origin, wsDial, new HeartbeatRuntime(), { onClosed: () => {} })
    const epoch = await control.open()
    const bindingId = crypto.randomUUID()
    h.service.bindings.set(bindingId, h.service.bindingView(bindingId))
    await h.api.publishGrant(bindingId, {
      connectionEpoch: epoch,
      expectedVersion: 0,
      state: "active",
      scopes: ["sessions:list", "sessions:read"],
    })
    const credential = await h.api.channelToken(bindingId, {
      deviceGroupId: crypto.randomUUID(),
      lane: "command",
      grantVersion: 1,
      connectionEpoch: epoch,
    })
    const events = { frames: [] as Record<string, unknown>[], closed: [] as string[], fences: [] as Fence[] }
    const lane = new ContentLane("command", credential, h.http, () => h.service.origin, wsDial, new HeartbeatRuntime(), {
      onFence: async (_, fence) => {
        events.fences.push(fence)
        await onFence(fence)
      },
      onFrame: (_, frame) => events.frames.push(frame),
      onClosed: (_, reason) => events.closed.push(reason),
    })
    return { control, lane, credential, events }
  }

  test("attach -> fence -> durable gate -> fence-ack -> transport-ready, then business frames flow", async () => {
    using h = await harness()
    const order: string[] = []
    const { lane, control, events } = await laneFor(h, async () => {
      await Bun.sleep(20)
      order.push("gate")
    })
    const opened = lane.open()
    await opened
    const sent = h.service.frames.filter((f) => f.path.endsWith("/command")).map((f) => f.frame.type)
    expect(sent).toEqual(["attach", "fence-ack"])
    order.push(lane.ready ? "ready" : "not-ready")
    expect(order).toEqual(["gate", "ready"])
    const ack = h.service.frames.find((f) => f.frame.type === "fence-ack")!.frame
    expect(ack.fenceId).toBe(events.fences[0].fenceId)
    h.service.sendOnLane("command", { protocolVersion: 1, type: "request", operation: "sessions-list" })
    await until(() => events.frames.length === 1)
    // The lane answers the service heartbeat like the control socket.
    h.service.ping(h.service.lanes.get("command")!)
    await until(() => h.service.frames.some((f) => f.path.endsWith("/command") && f.frame.type === "heartbeat-pong"))
    lane.close()
    control.close()
  })

  test("a gate that fails is never acknowledged and the lane closes", async () => {
    using h = await harness()
    const { lane, control, events } = await laneFor(h, async () => {
      throw new Error("disk full")
    })
    await expect(lane.open()).rejects.toThrow()
    expect(h.service.frames.some((f) => f.frame.type === "fence-ack")).toBe(false)
    expect(events.closed[0]).toBe("gate_failed")
    control.close()
  })

  test("a re-fence stops business traffic until it is acknowledged again", async () => {
    using h = await harness()
    let release!: () => void
    let block = false
    const { lane, control, events } = await laneFor(h, () =>
      block ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve(),
    )
    await lane.open()
    block = true
    const attach = h.service.frames.find((f) => f.frame.type === "attach")!.frame
    h.service.sendTransportReady = false
    h.service.fence("command", attach)
    await until(() => events.fences.length === 2)
    expect(lane.ready).toBe(false)
    expect(lane.send({ type: "sessions-page" })).toBe(false)
    release()
    await until(() => h.service.frames.filter((f) => f.frame.type === "fence-ack").length === 2)
    lane.close()
    control.close()
  })
})
