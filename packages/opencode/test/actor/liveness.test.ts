import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime, Effect } from "effect"
import { ActorRegistry } from "../../src/actor/registry"
import { deriveLiveness, DEFAULT_LIVENESS_STALL_MS } from "../../src/actor/schema"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const testLayer = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

async function withRegistry(
  directory: string,
  fn: (rt: ManagedRuntime.ManagedRuntime<Session.Service | ActorRegistry.Service | Bus.Service, never>) => Promise<void>,
) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(testLayer)
      try {
        await fn(rt)
      } finally {
        await rt.dispose()
      }
    },
  })
}

// Pure-derivation table: deriveLiveness maps honest registry fields to the
// pull-side signal. No I/O — this pins the rule + threshold exactly.
describe("deriveLiveness (T39 derivation rule)", () => {
  const now = 1_000_000

  test("running + recent turn (within window) → progressing", () => {
    expect(
      deriveLiveness({ status: "running", lastOutcome: undefined, lastTurnTime: now - 1_000, turnCount: 1 }, now),
    ).toBe("progressing")
  })

  test("running + turn older than the window → stalled", () => {
    expect(
      deriveLiveness(
        { status: "running", lastOutcome: undefined, lastTurnTime: now - (DEFAULT_LIVENESS_STALL_MS + 1), turnCount: 1 },
        now,
      ),
    ).toBe("stalled")
  })

  test("not-yet-started child (turnCount 0) is never stalled — slow first turn is not a stall", () => {
    // last_turn_time is the spawn time; even far outside the window a child that
    // has not completed a turn (queued behind the concurrency gate / cold-start)
    // must read progressing, not stalled.
    expect(
      deriveLiveness(
        { status: "pending", lastOutcome: undefined, lastTurnTime: now - 10 * 60_000, turnCount: 0 },
        now,
      ),
    ).toBe("progressing")
    expect(
      deriveLiveness(
        { status: "running", lastOutcome: undefined, lastTurnTime: now - 10 * 60_000, turnCount: 0 },
        now,
      ),
    ).toBe("progressing")
  })

  test("pending is treated as live and split by the same window (once it has run a turn)", () => {
    expect(
      deriveLiveness({ status: "pending", lastOutcome: undefined, lastTurnTime: now, turnCount: 1 }, now),
    ).toBe("progressing")
    expect(
      deriveLiveness({ status: "pending", lastOutcome: undefined, lastTurnTime: now - 10 * 60_000, turnCount: 1 }, now),
    ).toBe("stalled")
  })

  test("exactly at the threshold boundary is still progressing (<= window)", () => {
    expect(
      deriveLiveness(
        { status: "running", lastOutcome: undefined, lastTurnTime: now - DEFAULT_LIVENESS_STALL_MS, turnCount: 1 },
        now,
      ),
    ).toBe("progressing")
  })

  test("custom stallMs overrides the default window", () => {
    // 5s-old turn: stalled under a 1s window, progressing under a 60s window.
    expect(
      deriveLiveness({ status: "running", lastOutcome: undefined, lastTurnTime: now - 5_000, turnCount: 1 }, now, 1_000),
    ).toBe("stalled")
    expect(
      deriveLiveness({ status: "running", lastOutcome: undefined, lastTurnTime: now - 5_000, turnCount: 1 }, now, 60_000),
    ).toBe("progressing")
  })

  test("terminal outcomes come straight from lastOutcome regardless of turn age", () => {
    expect(deriveLiveness({ status: "idle", lastOutcome: "success", lastTurnTime: 0, turnCount: 1 }, now)).toBe("success")
    expect(deriveLiveness({ status: "idle", lastOutcome: "failure", lastTurnTime: 0, turnCount: 1 }, now)).toBe("failure")
    expect(deriveLiveness({ status: "idle", lastOutcome: "cancelled", lastTurnTime: 0, turnCount: 1 }, now)).toBe(
      "cancelled",
    )
  })

  test("idle with no outcome → idle", () => {
    expect(deriveLiveness({ status: "idle", lastOutcome: undefined, lastTurnTime: 0, turnCount: 0 }, now)).toBe("idle")
  })
})

// Integration: the registry.liveness helper reads a real row and derives the
// signal. A row registered at now, then advanced via updateTurn, reads
// progressing under the default window; the same row reads stalled under a
// tiny window while its lastTurnTime stays put (turnCount unchanged).
describe("ActorRegistry.liveness (T39 integration)", () => {
  const register = (reg: ActorRegistry.Interface, sessionID: SessionID) =>
    reg.register({
      sessionID,
      actorID: sessionID,
      mode: "peer",
      parentActorID: undefined,
      agent: "build",
      description: "work",
      contextMode: "none",
      contextWatermark: undefined,
      background: true,
      lifecycle: "persistent",
    })

  test("running row with an advancing turn reads progressing (default window)", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "running" })))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateTurn(child.id, child.id)))

      const found = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id)))
      expect(found).toBeDefined()
      expect(found!.liveness).toBe("progressing")
      expect(found!.actor.turnCount).toBe(1)
    })
  })

  test("running row whose last turn is old + has run a turn reads stalled", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "running" })))
      // Advance one turn so the row is no longer a not-yet-started child; its
      // last_turn_time now dates from this updateTurn. With a 1ms staleness
      // window and no further advance, elapsed real time flips it to stalled.
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateTurn(child.id, child.id)))

      await new Promise((r) => setTimeout(r, 5))
      const before = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.get(child.id, child.id)))
      const found = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id, 1)))
      expect(found!.liveness).toBe("stalled")
      // turnCount advanced exactly once, then wedged.
      expect(found!.actor.turnCount).toBe(1)
      expect(found!.actor.lastTurnTime).toBe(before!.lastTurnTime)
    })
  })

  test("not-yet-started row (turnCount 0) reads progressing even far past the window", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "running" })))

      // No updateTurn: last_turn_time is the spawn time, turnCount stays 0. Even
      // with a 1ms staleness window (spawn time is now far outside it), a child
      // that has not run once must NOT read stalled — this is the slow-start
      // (queued / cold-start) false-positive guard.
      await new Promise((r) => setTimeout(r, 5))
      const found = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id, 1)))
      expect(found!.actor.turnCount).toBe(0)
      expect(found!.liveness).toBe("progressing")
    })
  })

  test("terminal idle+failure reads failure; idle+success reads success", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "idle", lastOutcome: "failure" })),
      )
      const failed = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id)))
      expect(failed!.liveness).toBe("failure")

      await rt.runPromise(
        ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "idle", lastOutcome: "success" })),
      )
      const done = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id)))
      expect(done!.liveness).toBe("success")
    })
  })

  test("liveness on an absent actor row returns undefined", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const found = await rt.runPromise(
        Effect.gen(function* () {
          const reg = yield* ActorRegistry.Service
          return yield* reg.liveness(SessionID.make("ses_missing"), "ses_missing")
        }),
      )
      expect(found).toBeUndefined()
    })
  })
})
