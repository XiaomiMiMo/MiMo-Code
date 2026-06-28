import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { Memory } from "../../src/memory"
import { ActorRegistry } from "../../src/actor/registry"
import { Actor, type AgentOutcome } from "../../src/actor/spawn"
import { spawnRef } from "../../src/actor/spawn-ref"
import { TaskRegistry } from "../../src/task/registry"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Actor stub that never resolves its outcome — simulates a writer subagent
// stuck waiting on an LLM round-trip the shutdown budget can't afford.
// Also populates spawnRef so tryStartCheckpointWriter resolves the actor at
// runtime — see src/actor/spawn-ref.ts for the late-bind mechanism that
// prod uses to break the Actor → SessionPrompt → SessionCheckpoint cycle.
const hangingActor = Layer.effect(
  Actor.Service,
  Effect.gen(function* () {
    const prevSpawnRef = spawnRef.current
    let counter = 0
    const impl = Actor.Service.of({
      spawn: (input) =>
        Effect.gen(function* () {
          counter += 1
          const outcome = yield* Deferred.make<AgentOutcome>()
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
  hangingActor,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

describe("SessionCheckpoint.drainWriters", () => {
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
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        // Writer needs at least one message to proceed past the empty-skip guard.
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

        // Actor.spawn returns a never-resolving outcome — simulates an LLM
        // round-trip that the shutdown budget can't afford to wait on.
        const outcome = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(outcome).toBe("started")

        const result = yield* svc.drainWriters({ timeoutMs: 50 })
        expect(result.drained).toBe(0)
        expect(result.timedOut).toBe(1)
      }),
    ),
  )

  it.live(
    "F40 queue-1 writer: 3 bursty triggers fire writer1 + drain pending (newest wins)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        // Writer needs at least one message to proceed past the empty-skip guard.
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

        // writer1: nothing running yet → starts and runs (hangs).
        const r1 = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(r1).toBe("started")

        // writer2: writer1 still running → queued (1-slot pending).
        const r2 = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(r2).toBe("queued")

        // writer3: writer1 still running, writer2 in pending → writer3 evicts
        // writer2 and takes its slot (newest wins — writer3's range is a
        // strict superset of writer2's).
        const r3 = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(r3).toBe("queued")
      }),
    ),
  )
})
