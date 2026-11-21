import { describe, expect, test } from "bun:test"
import { HeartbeatRuntime, type HeartbeatMember } from "../src/heartbeat"

const CONNECTION = "5b0e7f7e-0d4c-4b8e-9d55-0f7a1d1e2c3b"
const READY = {
  protocolVersion: 1,
  type: "heartbeat-ready",
  connectionId: CONNECTION,
  policyVersion: 1,
  pingIntervalMs: 25000,
  ackTimeoutMs: 10000,
  watchdogTimeoutMs: 45000,
  freezeGraceMs: 10000,
}
const probe = (type: string, sequence: number) => ({
  protocolVersion: 1,
  type,
  connectionId: CONNECTION,
  policyVersion: 1,
  sequence,
})

function setup() {
  let now = 1_000
  const runtime = new HeartbeatRuntime(() => now)
  const sent: Record<string, unknown>[] = []
  const expired: string[] = []
  const confirmed: number[] = []
  const member: HeartbeatMember = runtime.register({
    send: (frame) => sent.push(frame),
    expired: (reason) => expired.push(reason),
    confirmed: (pongAt) => confirmed.push(pongAt),
  })
  return {
    runtime,
    member,
    sent,
    expired,
    confirmed,
    advance(ms: number) {
      now += ms
      runtime.tick()
    },
    set now(value: number) {
      now = value
    },
    get now() {
      return now
    },
  }
}

describe("service heartbeat", () => {
  test("a ping is answered with the same frame as a pong, its confirmation reports the answer time", () => {
    const h = setup()
    expect(h.member.consume(READY)).toBe(true)
    expect(h.member.configured).toBe(true)
    h.now = 2_000
    h.member.consume(probe("heartbeat-ping", 1))
    expect(h.sent).toEqual([probe("heartbeat-pong", 1)])
    h.now = 2_300
    h.member.consume(probe("heartbeat-confirmed", 1))
    expect(h.confirmed).toEqual([2_000])
    // A repeated confirmation extends nothing.
    h.member.consume(probe("heartbeat-confirmed", 1))
    expect(h.confirmed).toEqual([2_000])
    h.runtime.tick()
    expect(h.expired).toEqual([])
  })

  test("a repeated current ping is answered again, an older one is not", () => {
    const h = setup()
    h.member.consume(READY)
    h.member.consume(probe("heartbeat-ping", 2))
    h.member.consume(probe("heartbeat-ping", 2))
    h.member.consume(probe("heartbeat-ping", 1))
    expect(h.sent).toEqual([probe("heartbeat-pong", 2), probe("heartbeat-pong", 2)])
  })

  test("frames outside the contract fail the socket", () => {
    for (const frame of [
      { ...READY, pingIntervalMs: 4999 },
      { ...READY, extra: 1 },
      { ...READY, connectionId: "not-a-uuid" },
      { ...READY, watchdogTimeoutMs: 20000 },
    ]) {
      const h = setup()
      expect(() => h.member.consume(frame)).toThrow()
      expect(h.expired).toEqual(["heartbeat_protocol"])
    }
    const configured = () => {
      const h = setup()
      h.member.consume(READY)
      return h
    }
    for (const frame of [
      READY,
      probe("heartbeat-confirmed", 1),
      { ...probe("heartbeat-ping", 1), connectionId: crypto.randomUUID() },
      { ...probe("heartbeat-ping", 1), policyVersion: 2 },
      { ...probe("heartbeat-ping", 1), protocolVersion: 4 },
      probe("heartbeat-unknown", 1),
    ]) {
      const h = configured()
      expect(() => h.member.consume(frame)).toThrow()
      expect(h.expired).toEqual(["heartbeat_protocol"])
    }
    // A ping before the configuration is a protocol failure too.
    const early = setup()
    expect(() => early.member.consume(probe("heartbeat-ping", 1))).toThrow()
  })

  test("business frames are not heartbeat frames", () => {
    const h = setup()
    expect(h.member.consume({ protocolVersion: 1, type: "ready" })).toBe(false)
  })

  test("a socket never configured, or silent past the watchdog, expires", () => {
    const unconfigured = setup()
    unconfigured.advance(4_999)
    expect(unconfigured.expired).toEqual([])
    unconfigured.advance(1)
    expect(unconfigured.expired).toEqual(["heartbeat_configuration_timeout"])

    const silent = setup()
    silent.member.consume(READY)
    for (let i = 0; i < 179; i++) silent.advance(250)
    expect(silent.expired).toEqual([])
    silent.advance(250)
    expect(silent.expired).toEqual(["heartbeat_watchdog_timeout"])
  })

  test("business traffic keeps a socket alive between probes", () => {
    const h = setup()
    h.member.consume(READY)
    for (let i = 0; i < 400; i++) {
      h.advance(250)
      h.member.inbound()
    }
    expect(h.expired).toEqual([])
  })

  test("a badly late check asks for the current probe once; only a fresh heartbeat ends the grace", () => {
    const h = setup()
    h.member.consume(READY)
    h.advance(10_001)
    expect(h.sent).toEqual([{ protocolVersion: 1, type: "heartbeat-check", connectionId: CONNECTION, policyVersion: 1 }])
    h.member.consume(probe("heartbeat-ping", 1))
    h.advance(250)
    // The grace is over; a second freeze may ask again.
    h.advance(10_001)
    expect(h.sent.filter((f) => f.type === "heartbeat-check")).toHaveLength(2)
    h.advance(10_000)
    expect(h.expired).toEqual(["heartbeat_grace_timeout"])
  })

  test("a heartbeat that arrives after the grace ran out fails the socket", () => {
    const h = setup()
    h.member.consume(READY)
    h.advance(10_001)
    h.now = h.now + 10_000
    expect(() => h.member.consume(probe("heartbeat-ping", 1))).toThrow()
    expect(h.expired).toEqual(["heartbeat_protocol"])
  })

  test("a removed member gets no more checks and the last one stops the timer", () => {
    const h = setup()
    expect(h.runtime.size).toBe(1)
    h.member.remove()
    expect(h.runtime.size).toBe(0)
    h.advance(60_000)
    expect(h.expired).toEqual([])
  })
})
