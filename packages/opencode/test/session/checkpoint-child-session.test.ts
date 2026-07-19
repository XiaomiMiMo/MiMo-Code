import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { Memory } from "../../src/memory"
import { ActorRegistry } from "../../src/actor/registry"
import { Actor, type AgentOutcome } from "../../src/actor/spawn"
import { spawnRef } from "../../src/actor/spawn-ref"
import { prefixCaptureRef } from "../../src/session/prefix-capture-ref"
import { TaskRegistry } from "../../src/task/registry"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { SessionPrune } from "../../src/session/prune"
import { Database } from "../../src/storage"
import { SessionTable, MessageTable } from "../../src/session/session.sql"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Closure-shared state so tests can inspect spawn behavior. Mirrors
// hangingActor in checkpoint-drain.test.ts but adds counter access plus
// "settle the next outcome" knobs (success for T3, failure for T9/T10).
const spawnLog: { count: number; lastInput?: { sessionID: string; parentSessionID?: string; mode: string } } = { count: 0 }
const settleNextSuccess: { value: boolean } = { value: false }
// T10 uses explicit (test-driven) settlement to avoid the documented race
// in prune.ts:321-329 (settle watcher in checkpoint.ts deletes writers Map
// before prune's waitForWriter has a chance to grab it). Collected outcomes
// are settled with "failure" by the test AFTER fireCheckpoints returns, so
// both watchers see the failure.
const pendingOutcomes: Array<Deferred.Deferred<AgentOutcome>> = []

// Actor stub: never resolves outcome by default (T1, T2, T7 use this).
// Knobs:
//   - settleNextSuccess: spawn settles outcome with success immediately (T3)
//   - pendingOutcomes: spawn pushes the outcome into this array so the test
//     can settle it explicitly later (T9, T10)
const recordingActor = Layer.effect(
  Actor.Service,
  Effect.gen(function* () {
    const prevSpawnRef = spawnRef.current
    let counter = 0
    const impl = Actor.Service.of({
      spawn: (input) =>
        Effect.gen(function* () {
          counter += 1
          spawnLog.count = counter
          spawnLog.lastInput = {
            sessionID: input.sessionID,
            parentSessionID: input.parentSessionID,
            mode: input.mode,
          }
          const outcome = yield* Deferred.make<AgentOutcome>()
          if (settleNextSuccess.value) {
            settleNextSuccess.value = false
            yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
          }
          pendingOutcomes.push(outcome)
          return {
            actorID: `${input.agentType}-${counter}`,
            sessionID: input.sessionID,
            outcome,
          }
        }),
      cancel: () => Effect.void,
      getForkContext: () => Effect.succeed(undefined),
    })
    spawnRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (spawnRef.current === impl) spawnRef.current = prevSpawnRef
      }),
    )
    return impl
  }),
)

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  Memory.defaultLayer,
  TaskRegistry.defaultLayer,
  ActorRegistry.defaultLayer,
  recordingActor,
)

const checkpointLayer = SessionCheckpoint.layer.pipe(
  Layer.provide(SessionNs.defaultLayer),
  Layer.provideMerge(deps),
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  checkpointLayer,
  // Prune depends on Checkpoint + Session + Config + ActorRegistry, all of
  // which are in the layers above. Used by T7 only.
  SessionPrune.layer.pipe(Layer.provide(checkpointLayer), Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

// Reset closure state before every test (Effect.sync inside the test body).
// Also clear prefixCaptureRef — it's a global mutable ref that other tests in
// the full suite may have populated via SessionPrompt.layer initialisation.
// Leaving it set causes tryStartCheckpointWriter to attempt a real prefix
// capture (which needs a live Provider for the providerID we pass) and fail.
// See src/session/prefix-capture-ref.ts.
const resetSpawnLog = Effect.sync(() => {
  spawnLog.count = 0
  spawnLog.lastInput = undefined
  settleNextSuccess.value = false
  pendingOutcomes.length = 0
  prefixCaptureRef.current = undefined
})

// Seeds a parent session with a single user message + text part — same
// minimum the writer needs to clear the empty-skip guard.
const seedParentSession = Effect.fn("seedParentSession")(function* () {
  const ssn = yield* SessionNs.Service
  const info = yield* ssn.create({})
  const user = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: info.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: info.id,
    type: "text",
    text: "seed",
  })
  return { info, endMessageID: user.id }
})

describe("checkpoint writer child-session isolation", () => {
  it.live(
    "T1: writer spawn creates a child session with parent_id set and 'checkpoint-writer:' title",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* resetSpawnLog
        const svc = yield* SessionCheckpoint.Service
        const { info } = yield* seedParentSession()

        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(outcome).toBe("started")

        const children = yield* Effect.sync(() =>
          Database.use((d) =>
            d.select().from(SessionTable).where(eq(SessionTable.parent_id, info.id)).all(),
          ),
        )

        expect(children.length).toBe(1)
        expect(children[0].title.startsWith("checkpoint-writer:")).toBe(true)
        expect(children[0].parent_id).toBe(info.id)

        // Wire-check (M1 of MR review !162): the spawn input must carry
        // parentSessionID = parent so forkWork → triggerActorPreStop →
        // splitover plugin can re-derive PARENT-keyed paths. Without this
        // the splitover plugin reads checkpointPath(child) → empty file →
        // false topic-missing → MAX_PRE_REACT loop.
        expect(spawnLog.lastInput?.sessionID).toBe(children[0].id)
        expect(spawnLog.lastInput?.parentSessionID).toBe(info.id)
      }),
    ),
  )

  it.live(
    "T2: writer spawn does not pollute parent's message table",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* resetSpawnLog
        const svc = yield* SessionCheckpoint.Service
        const { info } = yield* seedParentSession()

        const before = yield* Effect.sync(() =>
          Database.use((d) =>
            d.select().from(MessageTable).where(eq(MessageTable.session_id, info.id)).all(),
          ),
        )

        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(outcome).toBe("started")

        const after = yield* Effect.sync(() =>
          Database.use((d) =>
            d.select().from(MessageTable).where(eq(MessageTable.session_id, info.id)).all(),
          ),
        )

        expect(after.length).toBe(before.length)
      }),
    ),
  )

  it.live(
    "T3: settle watcher advances PARENT's last_checkpoint_message_id, child's stays null",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* resetSpawnLog
        // Have actor.spawn resolve outcome immediately so the settle watcher fires.
        settleNextSuccess.value = true

        const svc = yield* SessionCheckpoint.Service
        const { info, endMessageID } = yield* seedParentSession()

        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(outcome).toBe("started")

        // Poll the parent row until the settle watcher (forkIn'd inside the
        // layer's scope) advances last_checkpoint_message_id. The watcher runs
        // on a separate fiber from this test's main, so there's no clean
        // synchronization API — but the watcher does land within a few ticks.
        const readParent = Effect.sync(() =>
          Database.use((d) =>
            d.select().from(SessionTable).where(eq(SessionTable.id, info.id)).get(),
          ),
        )
        let parentRow = yield* readParent
        for (let i = 0; i < 50 && !parentRow?.last_checkpoint_message_id; i++) {
          yield* Effect.sleep("20 millis")
          parentRow = yield* readParent
        }

        const childRows = yield* Effect.sync(() =>
          Database.use((d) =>
            d.select().from(SessionTable).where(eq(SessionTable.parent_id, info.id)).all(),
          ),
        )

        expect(parentRow?.last_checkpoint_message_id).toBe(endMessageID)
        expect(childRows.length).toBe(1)
        expect(childRows[0].last_checkpoint_message_id ?? null).toBeNull()
      }),
    ),
  )

  it.live(
    "T7: fireCheckpoints inside the writer's child session short-circuits via mode='subagent' guard (no second spawn)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* resetSpawnLog
        const svc = yield* SessionCheckpoint.Service
        const prune = yield* SessionPrune.Service
        const reg = yield* ActorRegistry.Service
        const { info } = yield* seedParentSession()

        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(outcome).toBe("started")
        expect(spawnLog.count).toBe(1)

        const childRows = yield* Effect.sync(() =>
          Database.use((d) =>
            d.select().from(SessionTable).where(eq(SessionTable.parent_id, info.id)).all(),
          ),
        )
        expect(childRows.length).toBe(1)
        const childID = childRows[0].id

        // The recordingActor stub doesn't auto-register the actor (real
        // Actor.spawn does — see spawnSubagent in actor/spawn.ts:641). Manually
        // register the writer's actor in the child session as mode:"subagent"
        // to mirror what the real spawn would have done.
        const writerActorID = `checkpoint-writer-${spawnLog.count}`
        yield* reg.register({
          sessionID: childID,
          actorID: writerActorID,
          mode: "subagent",
          agent: "checkpoint-writer",
          description: "writer",
          contextMode: "full",
          background: true,
          lifecycle: "ephemeral",
        })

        // Simulate fireCheckpoints being called from inside the child session's
        // actor loop. The mode==='subagent' guard at prune.ts:271 must short-
        // circuit BEFORE tryStartCheckpointWriter (and thus actor.spawn) is
        // invoked. We use a token bag well above any threshold so the only
        // thing preventing a second spawn IS the subagent guard.
        const fakeModel = ProviderTest.model({
          providerID: ProviderID.make("test"),
          id: ModelID.make("test-model"),
        })
        yield* prune.fireCheckpoints({
          sessionID: childID,
          model: fakeModel,
          tokens: { input: 10_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          promptOps: {} as never,
          agentID: writerActorID,
        })

        // Spawn count must still be 1 — no second writer was spawned.
        expect(spawnLog.count).toBe(1)
      }),
    ),
  )

  it.live(
    "T9: spawn failure clears the per-session lock and the next call can spawn again",
    // fork:true so the fixture's tiny seed (one user message) doesn't hit the
    // M1 empty-delta short-circuit on the second tryStartCheckpointWriter call:
    // after the first attempt's settle watcher advances last_checkpoint_message_id
    // onto the only message, fork:false would compute delta=[] and return
    // "skipped". The lock-clearing semantic this test verifies is identical
    // across fork modes.
    provideTmpdirInstance(
      () =>
      Effect.gen(function* () {
        yield* resetSpawnLog
        const svc = yield* SessionCheckpoint.Service
        const { info } = yield* seedParentSession()

        // Start a writer; outcome is collected in pendingOutcomes for explicit
        // settlement after we've confirmed the lock is held.
        const r1 = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(r1).toBe("started")
        expect(spawnLog.count).toBe(1)
        // Lock is held while the writer is in-flight.
        expect(yield* svc.isWriterRunning(info.id)).toBe(true)
        expect(pendingOutcomes.length).toBe(1)

        // Settle the outcome with a failure result. The settle watcher in
        // checkpoint.ts is forked into the layer scope; it deletes the
        // writers Map entry regardless of outcome status (success OR failure).
        const failureOutcome: AgentOutcome = { status: "failure", error: "test injected" }
        yield* Deferred.succeed(pendingOutcomes[0], failureOutcome)

        // Poll until the settle watcher (separate fiber) has cleared the
        // writers Map. Mirrors T3's polling pattern.
        let running = yield* svc.isWriterRunning(info.id)
        for (let i = 0; i < 50 && running; i++) {
          yield* Effect.sleep("20 millis")
          running = yield* svc.isWriterRunning(info.id)
        }
        expect(running).toBe(false)

        // Lock cleared → a fresh tryStartCheckpointWriter call can fire a new
        // writer, proving no permanent gate persists in checkpoint.ts itself.
        // (writerFailures lives in prune.ts as closure-private state — its
        // counter is observed indirectly via T10's MAX_WRITER_FAILURES gate.)
        const r2 = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(r2).toBe("started")
        expect(spawnLog.count).toBe(2)

        // Transactional invariant: on a FAILED writer the parent's
        // last_checkpoint_message_id must NOT advance. The checkpoint content
        // and the watermark move together or not at all; advancing on failure
        // would "consume" the delta the failed checkpoint never captured and
        // silently drop it from future rebuilds. (The settle watcher still
        // clears the in-flight writers Map on failure — asserted above — so a
        // fresh writer can retry; only the DB watermark is gated on success.)
        const parentRow = yield* Effect.sync(() =>
          Database.use((d) =>
            d.select().from(SessionTable).where(eq(SessionTable.id, info.id)).get(),
          ),
        )
        expect(parentRow?.last_checkpoint_message_id ?? undefined).toBeUndefined()
      }),
      { config: { checkpoint: { fork: true } } },
    ),
  )

  it.live(
    "T10: MAX_WRITER_FAILURES consecutive failures stops fireCheckpoints from spawning more writers",
    // fork:true for the same reason as T9: tiny-seed fixture would hit M1
    // empty-delta short-circuit on iterations 2+ if fork:false were used.
    // The failure-counter gate this test verifies is fork-agnostic.
    provideTmpdirInstance(
      () =>
      Effect.gen(function* () {
        yield* resetSpawnLog
        const svc = yield* SessionCheckpoint.Service
        const prune = yield* SessionPrune.Service
        const { info } = yield* seedParentSession()

        const fakeModel = ProviderTest.model({
          providerID: ProviderID.make("test"),
          id: ModelID.make("test-model"),
        })
        // Tokens above the FIRST threshold only (default thresholds for the
        // fake model's 200K window: 20%/40%/60%/80% = 40K/80K/120K/160K).
        // We deliberately stop at one crossed threshold per call: triggering
        // multiple in the same call would queue pending writers (1-slot
        // queue, see checkpoint.ts:508-517), and the settle watcher would
        // drain pending into a fresh spawn — masking the failure-counter
        // gate by re-populating the writers Map.
        const oneOverFirstThreshold = {
          input: 50_000,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        } as const

        // Drive MAX_WRITER_FAILURES (default 3) consecutive failures via
        // fireCheckpoints — that's the entry point that owns writerFailures.
        // Each iteration:
        //   1. fireCheckpoints triggers tryStartCheckpointWriter ("started")
        //   2. Test settles the captured outcome with failure
        //   3. Poll until settle watcher clears writers Map (lock released)
        //   4. Poll a bit longer so prune's forkDetach watcher reads the
        //      failure (otherwise the writers.delete race documented in
        //      prune.ts:321-329 would leave the counter un-incremented and
        //      the test flaky).
        for (let attempt = 1; attempt <= 3; attempt++) {
          const before = spawnLog.count
          yield* prune.fireCheckpoints({
            sessionID: info.id,
            model: fakeModel,
            tokens: oneOverFirstThreshold,
            promptOps: {} as never,
          })
          expect(spawnLog.count).toBe(before + 1)

          // Wait for the prune-side watcher fiber (forkDetach) to actually
          // start AND grab the WriterState reference via `writers.get(...)`
          // inside `waitForWriter`. That read MUST happen before we settle
          // the outcome below — otherwise the checkpoint-side settle watcher
          // (which is forked first, inside tryStartCheckpointWriter) clears
          // the writers Map and the prune watcher then sees "no-writer",
          // missing the failure and never incrementing writerFailures.
          // (See prune.ts:321-329 for the documented race; the runtime
          // tick here is the test-side mitigation.)
          yield* Effect.sleep("50 millis")

          // Settle the just-spawned writer with failure. Both watchers now
          // wake from their Deferred.await: the checkpoint-side runs
          // writers.delete + DB update; the prune-side runs
          // writerFailures.set and (when attempt < maxFailures)
          // crossed.delete so the next iteration can re-fire the threshold.
          const outcome = pendingOutcomes[pendingOutcomes.length - 1]
          yield* Deferred.succeed(outcome, { status: "failure", error: `attempt ${attempt}` })

          // Poll until the checkpoint-side settle watcher has cleared the
          // writers Map (lock released).
          let running = yield* svc.isWriterRunning(info.id)
          for (let i = 0; i < 50 && running; i++) {
            yield* Effect.sleep("20 millis")
            running = yield* svc.isWriterRunning(info.id)
          }
          expect(running).toBe(false)
          // Extra ticks so the prune-side watcher's continuation
          // (writerFailures.set + crossed.delete) lands before the next
          // fireCheckpoints reads `crossed` / `already`.
          yield* Effect.sleep("100 millis")
        }

        // After 3 failures, fireCheckpoints should NOT spawn a 4th writer.
        // Mechanism: on the 3rd failure the prune watcher hits
        // `next >= maxFailures` and skips `crossed.delete`. The threshold
        // remains in `already`, so the 4th fireCheckpoints invocation finds
        // `already.has(t)` === true and continues without calling
        // tryStartCheckpointWriter. (See prune.ts:339-352.)
        const beforeFourth = spawnLog.count
        expect(beforeFourth).toBe(3)
        yield* prune.fireCheckpoints({
          sessionID: info.id,
          model: fakeModel,
          tokens: oneOverFirstThreshold,
          promptOps: {} as never,
        })
        expect(spawnLog.count).toBe(beforeFourth)
      }),
      { config: { checkpoint: { fork: true } } },
    ),
  )
})
