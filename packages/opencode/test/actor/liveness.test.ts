import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime, Effect } from "effect"
import { ActorRegistry } from "../../src/actor/registry"
import {
  deriveLiveness,
  DEFAULT_LIVENESS_STALL_MS,
  DEFAULT_LIVENESS_ABANDON_MS,
  ACTIVITY_COALESCE_MS,
} from "../../src/actor/schema"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
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
//
// The evidence is lastActivityTime (the last part write for the actor's slice),
// NOT lastTurnTime/turnCount. Cases marked REWRITTEN below previously asserted
// step-grained semantics — chiefly that a `turnCount === 0` row reads
// `progressing` however long it has been silent. That leniency existed because
// the old signal could only see a COMPLETED step; with activity granularity it
// is a fabrication, so those assertions were deliberately changed rather than
// relaxed. Nothing here was weakened to go green: every rewritten case makes a
// strictly more specific claim than the one it replaced.
describe("deriveLiveness (T39 derivation rule)", () => {
  const now = 1_000_000

  test("running + recent activity (within window) → progressing", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: now - 1_000,
          time: { created: now - 60_000, updated: now - 1_000 },
        },
        now,
      ),
    ).toBe("progressing")
  })

  test("running + activity older than the window → stalled", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: now - (DEFAULT_LIVENESS_STALL_MS + 1),
          time: { created: now - 10 * 60_000, updated: now },
        },
        now,
      ),
    ).toBe("stalled")
  })

  // THE DEFECT THIS CHANGE FIXES. A child inside a long tool call has completed
  // no step, so lastTurnTime and turnCount are frozen at their pre-step values
  // — under the old signal it was indistinguishable from a dead row and read
  // stalled (or, past the bound, idle). Its parts keep landing, so activity is
  // recent and it now reads progressing. lastTurnTime is deliberately ancient
  // here to prove the derivation does not consult it.
  test("child mid-step (no completed turn for 25m) but with recent activity is progressing", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: now - 2_000,
          time: { created: now - 25 * 60_000, updated: now - 2_000 },
        },
        now,
      ),
    ).toBe("progressing")
  })

  // The converse: plenty of completed steps, but nothing has landed since. A
  // step counter cannot express this, which is why it is no longer the evidence.
  test("child with many completed turns but no activity for an hour is not routable", () => {
    const live = deriveLiveness(
      {
        status: "running",
        lastOutcome: undefined,
        lastActivityTime: now - 60 * 60_000,
        time: { created: now - 2 * 60 * 60_000, updated: now - 60 * 60_000 },
      },
      now,
    )
    expect(live).not.toBe("progressing")
    expect(live).not.toBe("stalled")
    expect(live).toBe("idle")
  })

  // REWRITTEN (was: "not-yet-started child (turnCount 0) is never stalled").
  // The old case asserted `progressing` for a row silent for 10 minutes. The
  // replacement keeps the real intent — a freshly spawned child must not be
  // mistaken for wedged — and states it against the fallback that now carries
  // it: with no activity recorded, spawn time is the reference.
  test("freshly spawned child with no activity yet reads progressing via the spawn fallback", () => {
    expect(
      deriveLiveness(
        { status: "pending", lastOutcome: undefined, lastActivityTime: undefined, time: { created: now - 500, updated: now - 500 } },
        now,
      ),
    ).toBe("progressing")
    expect(
      deriveLiveness(
        { status: "running", lastOutcome: undefined, lastActivityTime: undefined, time: { created: now - 500, updated: now - 500 } },
        now,
      ),
    ).toBe("progressing")
  })

  // REWRITTEN (the stalled leg was `lastActivityTime: now - 5 * 60_000`). That
  // 5-minute age was a bare number chosen when the window was 90s; at a 6-minute
  // window it silently became a `progressing` fixture asserting `stalled`. Stated
  // against the constant instead, so it pins "past the window" — the thing the
  // case is about — at any window value. Not a relaxation: the claim is identical.
  test("pending is treated as live and split by the same window", () => {
    expect(
      deriveLiveness(
        { status: "pending", lastOutcome: undefined, lastActivityTime: now, time: { created: now - 60_000, updated: now } },
        now,
      ),
    ).toBe("progressing")
    expect(
      deriveLiveness(
        {
          status: "pending",
          lastOutcome: undefined,
          lastActivityTime: now - (DEFAULT_LIVENESS_STALL_MS + 1),
          time: { created: now - (DEFAULT_LIVENESS_STALL_MS + 60_000), updated: now - DEFAULT_LIVENESS_STALL_MS },
        },
        now,
      ),
    ).toBe("stalled")
  })

  test("exactly at the threshold boundary is still progressing (<= window)", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: now - DEFAULT_LIVENESS_STALL_MS,
          time: { created: now - DEFAULT_LIVENESS_STALL_MS - 1, updated: now },
        },
        now,
      ),
    ).toBe("progressing")
  })

  test("custom stallMs overrides the default window", () => {
    // 5s-old activity: stalled under a 1s window, progressing under a 60s window.
    const wedged = {
      status: "running" as const,
      lastOutcome: undefined,
      lastActivityTime: now - 5_000,
      time: { created: now - 6_000, updated: now - 5_000 },
    }
    expect(deriveLiveness(wedged, now, 1_000)).toBe("stalled")
    expect(deriveLiveness(wedged, now, 60_000)).toBe("progressing")
  })

  test("terminal outcomes come straight from lastOutcome regardless of activity age", () => {
    const terminal = { status: "idle" as const, lastActivityTime: 0, time: { created: 0, updated: 0 } }
    expect(deriveLiveness({ ...terminal, lastOutcome: "success" }, now)).toBe("success")
    expect(deriveLiveness({ ...terminal, lastOutcome: "failure" }, now)).toBe("failure")
    expect(deriveLiveness({ ...terminal, lastOutcome: "cancelled" }, now)).toBe("cancelled")
  })

  test("idle with no outcome → idle", () => {
    expect(
      deriveLiveness(
        { status: "idle", lastOutcome: undefined, lastActivityTime: undefined, time: { created: 0, updated: 0 } },
        now,
      ),
    ).toBe("idle")
  })

  // === The abandonment bound, now measured against activity ===
  // A row that died before producing anything used to read `progressing` forever
  // (turnCount === 0 returned early and skipped every check). It is now judged by
  // the same single bound as every other row, from spawn time when no activity
  // was ever recorded.
  test("never-started child spawned long ago does NOT read progressing", () => {
    const stillborn = {
      status: "pending" as const,
      lastOutcome: undefined,
      lastActivityTime: undefined,
      time: { created: now - 24 * 60 * 60_000, updated: now - 24 * 60 * 60_000 },
    }
    expect(deriveLiveness(stillborn, now)).not.toBe("progressing")
    expect(deriveLiveness(stillborn, now)).toBe("idle")
    expect(deriveLiveness({ ...stillborn, status: "running" }, now)).toBe("idle")
  })

  // REWRITTEN (was: "the turnCount-0 leniency still holds inside the abandonment
  // bound", which asserted `progressing` at 30m-minus-1ms of silence). Under one
  // uniform bound the honest reading of a quiet-but-not-abandoned row is
  // `stalled` — still routable, so nothing is lost operationally, and the
  // "in progress" claim is no longer manufactured.
  test("a quiet row inside the bound reads stalled, and stays routable", () => {
    const quiet = {
      status: "pending" as const,
      lastOutcome: undefined,
      lastActivityTime: undefined,
      time: { created: now - (DEFAULT_LIVENESS_ABANDON_MS - 1), updated: now },
    }
    expect(deriveLiveness(quiet, now)).toBe("stalled")
    // Exactly at the bound is still inside it (> abandonMs, same <= convention
    // as stallMs).
    const atBound = { ...quiet, time: { created: now - DEFAULT_LIVENESS_ABANDON_MS, updated: now } }
    expect(deriveLiveness(atBound, now)).toBe("stalled")
    // One millisecond past it, the claim is no longer believed.
    const past = { ...quiet, time: { created: now - (DEFAULT_LIVENESS_ABANDON_MS + 1), updated: now } }
    expect(deriveLiveness(past, now)).toBe("idle")
  })

  // The bound is 10 minutes, down from the 30 that the step-grained signal
  // needed (a single legitimate step can run 20+ minutes). Pinned as a value so
  // a silent re-widening is a test failure, not a review question.
  test("the abandonment bound is 10 minutes", () => {
    expect(DEFAULT_LIVENESS_ABANDON_MS).toBe(10 * 60_000)
    expect(DEFAULT_LIVENESS_ABANDON_MS).toBeGreaterThan(DEFAULT_LIVENESS_STALL_MS)
  })

  // === The stall window, re-derived for the activity signal ===
  // Measured inter-activity gaps over 43,120 real gaps on a 172-child roster.
  // These are the same numbers the abandonment bound was anchored to; the stall
  // window is now anchored to the same set instead of to the old step cadence.
  const GAP_P99_MS = 38_048
  const GAP_P99_9_MS = 296_811

  // THE FALSE POSITIVE THIS CHANGE FIXES, at the age it was actually observed.
  // Two background children sitting inside single long steps (`bun ci`, a full
  // test suite, `git worktree add`) emitted "appears stalled" notifications at
  // ~90-130s of apparent silence while writing parts continuously — a tool's
  // streaming output calls ctx.metadata per chunk, which reaches updatePart and
  // advances last_activity_time. Under the old 90s window every one of those was
  // a lie. lastTurnTime is deliberately ancient to prove the step clock is not
  // consulted. Fails on a 90s window; passes on the re-derived one.
  test("a child inside a long step whose activity is 130s old is NOT stalled", () => {
    for (const silentForMs of [90_001, 100_000, 130_000, GAP_P99_9_MS]) {
      expect(
        deriveLiveness(
          {
            status: "running",
            lastOutcome: undefined,
            lastActivityTime: now - silentForMs,
            // No completed step for 25 minutes — mid-step the whole time.
            time: { created: now - 25 * 60_000, updated: now - silentForMs },
          },
          now,
        ),
      ).toBe("progressing")
    }
  })

  // The converse, so widening the window cannot quietly disable the verdict:
  // genuine silence past the window still reads stalled, and stays routable
  // (stalled, not idle) until the abandonment bound.
  test("a child with genuinely no activity past the window IS stalled", () => {
    const quiet = (silentForMs: number) => ({
      status: "running" as const,
      lastOutcome: undefined,
      lastActivityTime: now - silentForMs,
      time: { created: now - (silentForMs + 60_000), updated: now - silentForMs },
    })
    // Exactly at the window is still progressing (<= convention); one ms past it flips.
    expect(deriveLiveness(quiet(DEFAULT_LIVENESS_STALL_MS), now)).toBe("progressing")
    expect(deriveLiveness(quiet(DEFAULT_LIVENESS_STALL_MS + 1), now)).toBe("stalled")
    // And it stays stalled — not idle — right up to the abandonment bound.
    expect(deriveLiveness(quiet(DEFAULT_LIVENESS_ABANDON_MS), now)).toBe("stalled")
    expect(deriveLiveness(quiet(DEFAULT_LIVENESS_ABANDON_MS + 1), now)).toBe("idle")
  })

  // Pinned as a VALUE so re-narrowing it back toward the step-cadence number is a
  // test failure, not a review question — the same treatment the abandonment bound
  // gets above.
  test("the stall window is 6 minutes", () => {
    expect(DEFAULT_LIVENESS_STALL_MS).toBe(6 * 60_000)
  })

  // The two measurements that produced that value, as executable invariants.
  test("the stall window clears the measured activity tail plus the coalescing lag", () => {
    // 90s sat strictly between p99 and p99.9, i.e. between 0.1% and 1% of gaps
    // from HEALTHY children exceeded it. That is what made it a false-positive
    // generator, and it is the property the window must not have again.
    expect(90_000).toBeGreaterThan(GAP_P99_MS)
    expect(90_000).toBeLessThan(GAP_P99_9_MS)
    // Above the deepest measured natural silence...
    expect(DEFAULT_LIVENESS_STALL_MS).toBeGreaterThan(GAP_P99_9_MS)
    // ...and above it by more than one coalesce interval, so the up-to-5s lag
    // between a real part write and the recorded column cannot by itself flip a
    // tail-but-healthy row. This is what disqualifies 300_000 (== registry.ts
    // STUCK_THRESHOLD_MS): 300_000 < 296_811 + 5_000.
    expect(DEFAULT_LIVENESS_STALL_MS).toBeGreaterThan(GAP_P99_9_MS + ACTIVITY_COALESCE_MS)
    expect(300_000).toBeLessThan(GAP_P99_9_MS + ACTIVITY_COALESCE_MS)
    // Still leaves a usable stalled band: the watchdog scans every 45s.
    expect(DEFAULT_LIVENESS_ABANDON_MS - DEFAULT_LIVENESS_STALL_MS).toBeGreaterThanOrEqual(4 * 45_000)
  })

  // === Defect A (read side): a row whose process is gone is not routable ===
  // ActorRegistry's orphan sweep is the only repair for a row whose owner died,
  // and it runs once at process init for rows of a different instance. Until then
  // the row keeps claiming running/pending, and both `progressing` and `stalled`
  // are presented to the orchestrator as "in progress" — routable, and implying
  // work is already in flight. Past the abandonment bound the derivation stops
  // believing the claim.
  test("started child still claiming running long after its last activity is not routable", () => {
    // The measured fixture: peer "Fix calc.py add() bug", replayed a day later.
    const dead = {
      status: "running" as const,
      lastOutcome: undefined,
      lastActivityTime: now - 24 * 60 * 60_000,
      time: { created: now - 25 * 60 * 60_000, updated: now - 24 * 60 * 60_000 },
    }
    const live = deriveLiveness(dead, now)
    expect(live).not.toBe("stalled")
    expect(live).not.toBe("progressing")
    expect(live).toBe("idle")
  })

  // REWRITTEN (was `lastActivityTime: now - 4 * 60_000` with a 2-minute custom
  // bound). 4 minutes was "past the 90s window but inside the 10m bound"; at a
  // 6-minute window it fell back inside the window and the default-bound leg would
  // have read `progressing`. Restated relative to both constants so it keeps
  // testing the only thing it was ever about — that abandonMs is honoured and
  // overridable — without re-encoding either threshold's value.
  test("custom abandonMs overrides the default bound", () => {
    const silentFor = DEFAULT_LIVENESS_STALL_MS + 60_000
    const row = {
      status: "running" as const,
      lastOutcome: undefined,
      lastActivityTime: now - silentFor,
      time: { created: now - (silentFor + 60_000), updated: now - silentFor },
    }
    // Past the stall window and inside the default 10m bound → stalled; abandoned
    // under a bound tighter than the silence.
    expect(deriveLiveness(row, now)).toBe("stalled")
    expect(deriveLiveness(row, now, DEFAULT_LIVENESS_STALL_MS, silentFor - 1)).toBe("idle")
  })

  // A nullable column arrives as `null`, not `undefined`, for every row written
  // before the migration. A `!== undefined` guard would typecheck, read
  // correctly, and let those rows through with `now - null === now` — i.e. always
  // past the bound, so every pre-migration running row would read idle. Pinned
  // with a raw-shaped row because that is the shape the DB actually produces.
  // See AGENTS.md "Reading a nullable column".
  test("a null activity column falls back to spawn time instead of being treated as present", () => {
    const raw = {
      status: "running" as const,
      lastOutcome: undefined,
      lastActivityTime: null as unknown as number | undefined,
      time: { created: now - 1_000, updated: now - 1_000 },
    }
    expect(deriveLiveness(raw, now)).toBe("progressing")
    const old = { ...raw, time: { created: now - 24 * 60 * 60_000, updated: now } }
    expect(deriveLiveness(old, now)).toBe("idle")
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

  // REWRITTEN (was: "not-yet-started row (turnCount 0) reads progressing even
  // far past the window"). That case pinned the unconditional turnCount-0
  // leniency: with a 1ms window it demanded `progressing`. The row is now judged
  // by activity, of which a freshly registered row has none, so spawn time is the
  // reference — progressing under the real window, stalled under a 1ms one. The
  // operational guarantee that mattered (a queued child is not called dead) is
  // preserved and asserted; the fabricated "progressing" is not.
  test("freshly registered row has no recorded activity and rides the spawn fallback", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "running" })))

      const row = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.get(child.id, child.id)))
      // register() writes NULL, and fromRow flattens it to undefined.
      expect(row!.lastActivityTime).toBeUndefined()
      expect(row!.turnCount).toBe(0)

      // Under the real window the spawn fallback keeps it routable and in-flight.
      const live = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id)))
      expect(live!.liveness).toBe("progressing")

      // Under a 1ms window the same row is honestly quiet — and `stalled` is
      // still a routable bucket, so nothing is dropped.
      await new Promise((r) => setTimeout(r, 5))
      const tight = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id, 1)))
      expect(tight!.liveness).toBe("stalled")
    })
  })

  // End-to-end for the writer: a real part write must advance the actor row's
  // last_activity_time. This is the whole mechanism — MAX(part.time_updated) is
  // already emitted today, and the PartUpdated projector is the single writer of
  // part rows, so it is where the heartbeat is recorded. turn_count stays 0
  // throughout: progress is visible with ZERO completed steps, which is exactly
  // what the step-grained signal could not express.
  test("a part write advances last_activity_time with turn_count still at 0", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "running" })))

      const before = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.get(child.id, child.id)))
      expect(before!.lastActivityTime).toBeUndefined()

      // A peer child's actor_id IS its own session id, and runAgentLoop passes
      // that actorID as the message's agentID — so the slice the projector
      // resolves through message.agent_id is this row.
      const messageID = MessageID.ascending()
      await rt.runPromise(
        Session.Service.use((s) =>
          s.updateMessage({
            id: messageID,
            role: "user" as const,
            sessionID: child.id,
            agentID: child.id,
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
            time: { created: Date.now() },
          }),
        ),
      )
      await rt.runPromise(
        Session.Service.use((s) =>
          s.updatePart({ id: PartID.ascending(), messageID, sessionID: child.id, type: "text", text: "working" }),
        ),
      )

      const after = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.get(child.id, child.id)))
      expect(after!.lastActivityTime).toBeDefined()
      expect(after!.lastActivityTime!).toBeGreaterThanOrEqual(before!.time.created)
      // The step counter did not move — activity is a strictly finer signal.
      expect(after!.turnCount).toBe(0)
      expect(after!.lastTurnTime).toBe(before!.lastTurnTime)

      const live = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id)))
      expect(live!.liveness).toBe("progressing")
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

  // The heartbeat rides the part-write path, and that path is unthrottled: the
  // bash tool's ctx.metadata fires once per decoded stdout chunk and reaches
  // Session.updatePart with no interval check, measured at 453-575 registry row
  // writes/sec for a chatty command. ACTIVITY_COALESCE_MS caps the column's
  // resolution via a staleness predicate in the projector's WHERE, so redundant
  // writes inside the interval match 0 rows instead of rewriting the row.
  test("coalescing: repeated part writes inside ACTIVITY_COALESCE_MS do not re-advance the column", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "running" })))

      const messageID = MessageID.ascending()
      await rt.runPromise(
        Session.Service.use((s) =>
          s.updateMessage({
            id: messageID,
            role: "user" as const,
            sessionID: child.id,
            agentID: child.id,
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
            time: { created: Date.now() },
          }),
        ),
      )
      const writePart = (text: string) => {
        const partID = PartID.ascending()
        return rt
          .runPromise(
            Session.Service.use((s) => s.updatePart({ id: partID, messageID, sessionID: child.id, type: "text", text })),
          )
          .then(() => partID)
      }

      // First write: the column is NULL, and the `IS NULL` disjunct must let it
      // through — a fresh row has to record its first activity.
      await writePart("first")
      const first = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.get(child.id, child.id)))
      expect(first!.lastActivityTime).toBeDefined()

      // Now a burst well inside the interval. Every one of these is a part write
      // that previously rewrote the registry row.
      const BURST = 40
      let lastPartID = ""
      for (let i = 0; i < BURST; i++) lastPartID = await writePart(`chunk ${i}`)

      const after = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.get(child.id, child.id)))
      // Pinned to the first write: all BURST redundant registry writes suppressed.
      expect(after!.lastActivityTime).toBe(first!.lastActivityTime)

      // The suppression is specific to the registry heartbeat — the parts
      // themselves still landed, so nothing was lost from the session.
      const stored = await rt.runPromise(
        Session.Service.use((s) => s.getPart({ sessionID: child.id, messageID, partID: lastPartID as any })),
      )
      expect(stored).toBeDefined()

      // And the coalesced row is still classified live, not stalled or idle.
      const live = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id)))
      expect(live!.liveness).toBe("progressing")
    })
  }, 60_000)

  // Semantics-preservation: coalescing must not let a genuinely active actor
  // drift out of `progressing`. Runs longer than ACTIVITY_COALESCE_MS with parts
  // arriving continuously and samples liveness at EVERY step, so a guard that
  // froze the column would surface as a stalled/idle sample rather than only at
  // the end.
  test("continuous activity keeps reading progressing across an interval longer than ACTIVITY_COALESCE_MS", async () => {
    // The safety of coalescing rests entirely on the interval being far below
    // the stall window: worst-case apparent age equals ACTIVITY_COALESCE_MS, so
    // the progressing/stalled flip is unreachable while this holds.
    expect(ACTIVITY_COALESCE_MS * 2).toBeLessThan(DEFAULT_LIVENESS_STALL_MS)
    expect(ACTIVITY_COALESCE_MS * 2).toBeLessThan(DEFAULT_LIVENESS_ABANDON_MS)

    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "running" })))

      const messageID = MessageID.ascending()
      await rt.runPromise(
        Session.Service.use((s) =>
          s.updateMessage({
            id: messageID,
            role: "user" as const,
            sessionID: child.id,
            agentID: child.id,
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
            time: { created: Date.now() },
          }),
        ),
      )

      const SPAN_MS = ACTIVITY_COALESCE_MS + 1_500
      const CADENCE_MS = 250
      const started = Date.now()
      const observed = new Set<number>()
      let samples = 0

      while (Date.now() - started < SPAN_MS) {
        await rt.runPromise(
          Session.Service.use((s) =>
            s.updatePart({
              id: PartID.ascending(),
              messageID,
              sessionID: child.id,
              type: "text",
              text: `t+${Date.now() - started}`,
            }),
          ),
        )
        const found = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id)))
        samples++
        // The whole point: an actor that never stops emitting parts is never
        // reported as anything but progressing, however coarse the column is.
        expect(found!.liveness).toBe("progressing")
        // The recorded activity is allowed to lag by the coalescing interval and
        // at most one more write cadence — never more.
        expect(Date.now() - found!.actor.lastActivityTime!).toBeLessThanOrEqual(ACTIVITY_COALESCE_MS + CADENCE_MS * 4)
        observed.add(found!.actor.lastActivityTime!)
        await new Promise((r) => setTimeout(r, CADENCE_MS))
      }

      // Real coverage of the window, not one lucky iteration.
      expect(samples).toBeGreaterThan(SPAN_MS / CADENCE_MS / 2)
      expect(Date.now() - started).toBeGreaterThan(ACTIVITY_COALESCE_MS)
      // The column is coalesced, not frozen: it advanced at least once more
      // after its first value now that the span exceeded the interval.
      expect(observed.size).toBeGreaterThanOrEqual(2)
    })
  }, 120_000)
})
