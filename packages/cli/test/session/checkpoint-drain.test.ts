import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
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
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Outcomes of every writer the stub spawned, in order, so a test can settle one.
const spawned: Deferred.Deferred<AgentOutcome>[] = []
let spawnReturnGate: Deferred.Deferred<void> | undefined

// Actor stub that never resolves its outcome — simulates a writer subagent
// stuck waiting on an LLM round-trip the shutdown budget can't afford.
// Also populates spawnRef so tryStartCheckpointWriter resolves the actor at
// runtime — see src/actor/spawn-ref.ts for the late-bind mechanism that
// prod uses to break the Actor → SessionPrompt → SessionCheckpoint cycle.
//
// prefixCaptureRef is a sibling late-bind global. Other test files in the same
// bun process (SessionPrompt.layer, fork-mode stubs) leave closures there that
// resolve Provider.getModel against a different instance and abort
// tryStartCheckpointWriter mid-flight. Clear it here so these tests never
// depend on cross-file leftovers.
const hangingActor = Layer.effect(
  Actor.Service,
  Effect.gen(function* () {
    const prevSpawnRef = spawnRef.current
    const prevPrefixCaptureRef = prefixCaptureRef.current
    let counter = 0
    const impl = Actor.Service.of({
      spawn: (input) =>
        Effect.gen(function* () {
          counter += 1
          const outcome = yield* Deferred.make<AgentOutcome>()
          spawned.push(outcome)
          if (spawnReturnGate) yield* Deferred.await(spawnReturnGate)
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
    prefixCaptureRef.current = undefined
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (spawnRef.current === impl) spawnRef.current = prevSpawnRef
        if (prefixCaptureRef.current === undefined) prefixCaptureRef.current = prevPrefixCaptureRef
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
  hangingActor,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

// Writer needs at least one message to proceed past the empty-skip guard.
const seedSession = Effect.fn("test.seedSession")(function* () {
  spawned.length = 0
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
  return info
})

const start = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const svc = yield* SessionCheckpoint.Service
    return yield* svc.tryStartCheckpointWriter({
      sessionID,
      model: { providerID: "test", modelID: "test-model" },
      promptOps: {} as never,
    })
  })

describe("SessionCheckpoint.drainWriters", () => {
  it.live(
    "concurrent starts queue while the first actor is still registering",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* seedSession()
        const gate = yield* Deferred.make<void>()
        spawnReturnGate = gate
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(gate, undefined).pipe(
            Effect.andThen(
              Effect.sync(() => {
                spawnReturnGate = undefined
              }),
            ),
          ),
        )
        const first = yield* start(info.id).pipe(Effect.forkChild({ startImmediately: true }))
        for (let i = 0; i < 200 && spawned.length === 0; i++) yield* Effect.sleep("10 millis")
        expect(spawned).toHaveLength(1)
        const second = yield* start(info.id).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.sleep("100 millis")
        yield* Deferred.succeed(gate, undefined)
        spawnReturnGate = undefined
        expect(yield* Fiber.join(first)).toBe("started")
        expect(yield* Fiber.join(second)).toBe("queued")
        expect(spawned).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "cancelling a waiting start keeps later starts behind actor registration",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* seedSession()
        const gate = yield* Deferred.make<void>()
        spawnReturnGate = gate
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(gate, undefined).pipe(
            Effect.andThen(
              Effect.sync(() => {
                spawnReturnGate = undefined
              }),
            ),
          ),
        )
        const first = yield* start(info.id).pipe(Effect.forkChild({ startImmediately: true }))
        for (let i = 0; i < 200 && spawned.length === 0; i++) yield* Effect.sleep("10 millis")
        expect(spawned).toHaveLength(1)
        const cancelled = yield* start(info.id).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.sleep("10 millis")
        yield* Fiber.interrupt(cancelled)
        const next = yield* start(info.id).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.sleep("100 millis")
        expect(spawned).toHaveLength(1)
        yield* Deferred.succeed(gate, undefined)
        spawnReturnGate = undefined
        expect(yield* Fiber.join(first)).toBe("started")
        expect(yield* Fiber.join(next)).toBe("queued")
      }),
    ),
  )

  it.live(
    "different sessions register checkpoint writers concurrently",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const firstInfo = yield* seedSession()
        const secondInfo = yield* seedSession()
        const gate = yield* Deferred.make<void>()
        spawnReturnGate = gate
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(gate, undefined).pipe(
            Effect.andThen(
              Effect.sync(() => {
                spawnReturnGate = undefined
              }),
            ),
          ),
        )
        const first = yield* start(firstInfo.id).pipe(Effect.forkChild({ startImmediately: true }))
        const second = yield* start(secondInfo.id).pipe(Effect.forkChild({ startImmediately: true }))
        for (let i = 0; i < 200 && spawned.length < 2; i++) yield* Effect.sleep("10 millis")
        expect(spawned).toHaveLength(2)
        yield* Deferred.succeed(gate, undefined)
        spawnReturnGate = undefined
        expect(yield* Fiber.join(first)).toBe("started")
        expect(yield* Fiber.join(second)).toBe("started")
      }),
    ),
  )

  it.live(
    "no active writers → drained=0, timedOut=0",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const result = yield* svc.drainWriters()
        expect(result).toEqual({ drained: 0, timedOut: 0 })
      }),
    ),
  )

  it.live(
    "hanging writer → short timeout reports timedOut=1",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const info = yield* seedSession()

        // Actor.spawn returns a never-resolving outcome — simulates an LLM
        // round-trip that the shutdown budget can't afford to wait on.
        expect(yield* start(info.id)).toBe("started")

        const result = yield* svc.drainWriters({ timeoutMs: 50 })
        expect(result).toEqual({ drained: 0, timedOut: 1 })
      }),
    ),
  )

  it.live(
    "writer settling during drain → drained=1, timedOut=0",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const info = yield* seedSession()
        expect(yield* start(info.id)).toBe("started")

        // startImmediately: drain must snapshot the writer before it settles.
        const drain = yield* svc.drainWriters({ timeoutMs: 5_000 }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(spawned[0], { status: "success" })
        expect(yield* Fiber.join(drain)).toEqual({ drained: 1, timedOut: 0 })
      }),
    ),
  )

  it.live(
    "F40 queue-1 writer: bursty triggers queue, settling writer1 fires the newest pending",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* seedSession()

        // writer1 starts and hangs; writer2 queues; writer3 evicts writer2
        // (newest wins — its range is a strict superset of writer2's).
        expect(yield* start(info.id)).toBe("started")
        expect(yield* start(info.id)).toBe("queued")
        expect(yield* start(info.id)).toBe("queued")
        expect(spawned).toHaveLength(1)

        // Settling writer1 drains the single pending slot as a fresh writer.
        yield* Deferred.succeed(spawned[0], { status: "success" })
        for (let i = 0; i < 200 && spawned.length < 2; i++) yield* Effect.sleep("10 millis")
        expect(spawned).toHaveLength(2)

        // The drained writer now owns the slot, so the next trigger queues.
        expect(yield* start(info.id)).toBe("queued")
      }),
    ),
  )
})
