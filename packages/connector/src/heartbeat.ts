// Service-coordinated heartbeat (Connect R60, `Mimo-Heartbeat: server-v1`).
//
// Every control and content socket negotiates it in the handshake and the 101
// must echo it. The service configures each socket once with heartbeat-ready,
// probes with heartbeat-ping and confirms our pong with heartbeat-confirmed; on
// the control socket a confirmation also means the online lease was renewed.
// One runtime owns a single timer for all sockets of a connection generation;
// channels only hand it the heartbeat frames they receive.

export const HEARTBEAT_HEADER = "Mimo-Heartbeat"
export const HEARTBEAT_MODE = "server-v1"

const PROTOCOL_VERSION = 1
const MAX_INT = 2147483647
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The service configures a socket right after attach; a socket left unconfigured this long is dead. */
const CONFIGURE_MS = 5_000
const TICK_MS = 250
const MAX_FRAME_BYTES = 1024
/** Native write budget the policy must leave room for (R60 parameters). */
const WRITE_BUDGET_MS = 5_000

export type HeartbeatPolicy = {
  pingIntervalMs: number
  ackTimeoutMs: number
  watchdogTimeoutMs: number
  freezeGraceMs: number
}

export type HeartbeatMember = {
  /** Every complete inbound frame; business traffic keeps the socket alive between probes. */
  inbound(): void
  /**
   * A frame whose type starts with `heartbeat-`: handled here, true when consumed.
   * Throws on a frame that breaks the heartbeat contract.
   */
  consume(frame: Record<string, unknown>): boolean
  /** Configured by heartbeat-ready; ready / transport-ready must not come before it. */
  readonly configured: boolean
  remove(): void
}

export type HeartbeatSocket = {
  send(frame: Record<string, unknown>): void
  /** The socket missed the heartbeat contract or its watchdog expired. */
  expired(reason: string): void
  /** A pong of ours was confirmed; `pongAt` is when that probe was first answered. */
  confirmed?(pongAt: number): void
}

type Member = HeartbeatSocket & {
  started: number
  checked: number
  inbound: number
  connectionId?: string
  policyVersion?: number
  policy?: HeartbeatPolicy
  sequence: number
  /** First pong time of each probe still awaiting confirmation (current and previous). */
  answered: Map<number, number>
  completed: Set<number>
  grace?: number
  graceUsed: boolean
}

class HeartbeatError extends Error {}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HeartbeatError("invalid heartbeat frame")
  }
  return value
}

function hasRequired(frame: Record<string, unknown>, keys: string[]): void {
  if (keys.some((key) => !Object.hasOwn(frame, key))) {
    throw new HeartbeatError("invalid heartbeat frame")
  }
}

const KNOWN_HEARTBEAT_TYPES = new Set(["heartbeat-ready", "heartbeat-ping", "heartbeat-confirmed"])

export class HeartbeatRuntime {
  private readonly members = new Set<Member>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly now: () => number = () => performance.now()) {}

  register(socket: HeartbeatSocket): HeartbeatMember {
    const time = this.now()
    const member: Member = {
      ...socket,
      started: time,
      checked: time,
      inbound: time,
      sequence: 0,
      answered: new Map(),
      completed: new Set(),
      graceUsed: false,
    }
    this.members.add(member)
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS)
      this.timer.unref?.()
    }
    return {
      inbound: () => {
        member.inbound = this.now()
      },
      consume: (frame) => this.consume(member, frame),
      get configured() {
        return member.policy !== undefined
      },
      remove: () => this.remove(member),
    }
  }

  get size(): number {
    return this.members.size
  }

  /** One timer pass; exposed for tests driving a manual clock. */
  tick(): void {
    const time = this.now()
    for (const member of [...this.members]) {
      const policy = member.policy
      if (!policy) {
        if (time - member.started >= CONFIGURE_MS) this.expire(member, "heartbeat_configuration_timeout")
        continue
      }
      const drift = time - member.checked
      member.checked = time
      if (member.grace !== undefined) {
        if (time >= member.grace) this.expire(member, "heartbeat_grace_timeout")
      } else if (drift > policy.ackTimeoutMs && !member.graceUsed) {
        // A badly late check (a frozen process): ask the service for the current probe once.
        member.graceUsed = true
        member.grace = time + policy.freezeGraceMs
        member.send({
          protocolVersion: PROTOCOL_VERSION,
          type: "heartbeat-check",
          connectionId: member.connectionId!,
          policyVersion: member.policyVersion!,
        })
      } else if (time - member.inbound >= policy.watchdogTimeoutMs) {
        this.expire(member, "heartbeat_watchdog_timeout")
      }
    }
  }

  private consume(member: Member, frame: Record<string, unknown>): boolean {
    if (typeof frame.type !== "string" || !KNOWN_HEARTBEAT_TYPES.has(frame.type)) return false
    if (!this.members.has(member)) return true
    try {
      if (new TextEncoder().encode(JSON.stringify(frame)).length > MAX_FRAME_BYTES) {
        throw new HeartbeatError("heartbeat frame too large")
      }
      this.accept(member, frame)
    } catch (error) {
      if (!(error instanceof HeartbeatError)) throw error
      this.expire(member, "heartbeat_protocol")
      throw error
    }
    return true
  }

  private accept(member: Member, frame: Record<string, unknown>): void {
    const time = this.now()
    // A grace window ends only with a fresh valid heartbeat inside it.
    if (member.grace !== undefined && time >= member.grace) throw new HeartbeatError("grace expired")
    if (frame.protocolVersion !== PROTOCOL_VERSION) throw new HeartbeatError("invalid heartbeat frame")
    const identity = ["protocolVersion", "type", "connectionId", "policyVersion"]
    if (frame.type === "heartbeat-ready") {
      hasRequired(frame, [...identity, "pingIntervalMs", "ackTimeoutMs", "watchdogTimeoutMs", "freezeGraceMs"])
      // Configured once per socket; a new policy takes a new connection.
      if (member.policy || typeof frame.connectionId !== "string" || !UUID.test(frame.connectionId)) {
        throw new HeartbeatError("invalid heartbeat-ready")
      }
      const pingIntervalMs = integer(frame.pingIntervalMs, 5000, 60000)
      const ackTimeoutMs = integer(frame.ackTimeoutMs, 1000, 30000)
      member.policy = {
        pingIntervalMs,
        ackTimeoutMs,
        watchdogTimeoutMs: integer(frame.watchdogTimeoutMs, pingIntervalMs + ackTimeoutMs + WRITE_BUDGET_MS, 120000),
        freezeGraceMs: integer(frame.freezeGraceMs, 1000, 10000),
      }
      member.connectionId = frame.connectionId
      member.policyVersion = integer(frame.policyVersion, 1, MAX_INT)
      member.inbound = time
      member.checked = time
      return
    }
    hasRequired(frame, [...identity, "sequence"])
    if (!member.policy || frame.connectionId !== member.connectionId || frame.policyVersion !== member.policyVersion) {
      throw new HeartbeatError("heartbeat for another connection")
    }
    const sequence = integer(frame.sequence, 1, MAX_INT)
    if (frame.type === "heartbeat-confirmed") {
      // A repeated confirmation never extends anything.
      if (member.completed.has(sequence)) return
      const pongAt = member.answered.get(sequence)
      if (pongAt === undefined) throw new HeartbeatError("confirmation of an unanswered probe")
      member.answered.delete(sequence)
      member.completed.add(sequence)
      while (member.completed.size > 2) member.completed.delete(member.completed.values().next().value!)
      this.alive(member, time)
      member.confirmed?.(pongAt)
      return
    }
    // An old probe does not prove liveness; the current one may be answered again.
    if (sequence < member.sequence) return
    if (sequence > member.sequence) {
      member.sequence = sequence
      member.answered.set(sequence, time)
      for (const key of member.answered.keys()) if (key < sequence - 1) member.answered.delete(key)
      this.alive(member, time)
    }
    member.send({
      protocolVersion: PROTOCOL_VERSION,
      type: "heartbeat-pong",
      connectionId: member.connectionId!,
      policyVersion: member.policyVersion!,
      sequence,
    })
  }

  private alive(member: Member, time: number): void {
    member.inbound = time
    member.checked = time
    member.grace = undefined
    member.graceUsed = false
  }

  private expire(member: Member, reason: string): void {
    if (!this.members.has(member)) return
    this.remove(member)
    member.expired(reason)
  }

  private remove(member: Member): void {
    this.members.delete(member)
    if (this.members.size === 0) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}
