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

// A controllable actor: each spawn's outcome Deferred is captured into
// `outcomes` so the test can resolve it as success or failure on demand. This
// lets us drive the checkpoint settle-watcher to a chosen terminal state and
// then observe whether the watermark (last_checkpoint_message_id) advanced.
const outcomes: Deferred.Deferred<AgentOutcome>[] = []
const controllableActor = Layer.effect(
  Actor.Service,
  Effect.gen(function* () {
    const prev = spawnRef.current
    let counter = 0
    const impl = Actor.Service.of({
      spawn: (input) =>
        Effect.gen(function* () {
          counter += 1
          const outcome = yield* Deferred.make<AgentOutcome>()
          outcomes.push(outcome)
          return { actorID: `${input.agentType}-${counter}`, sessionID: input.sessionID, outcome }
        }),
      cancel: () => Effect.void,
      getForkContext: () => Effect.succeed(undefined),
    })
    spawnRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (spawnRef.current === impl) spawnRef.current = prev
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
  controllableActor,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

// Seed a session with a few messages and start a writer. Returns the session
// info AND the exact outcome Deferred for THIS writer (captured by the
// array-length delta, so parallel tests never resolve each other's writer).
function seedAndStartWriter() {
  return Effect.gen(function* () {
    const svc = yield* SessionCheckpoint.Service
    const ssn = yield* SessionNs.Service
    const info = yield* ssn.create({})
    for (let i = 0; i < 2; i++) {
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
        text: `seed ${i}`,
      })
    }
    const idxBefore = outcomes.length
    const started = yield* svc.tryStartCheckpointWriter({
      sessionID: info.id,
      model: { providerID: "test", modelID: "test-model" },
      promptOps: {} as never,
    })
    expect(started).toBe("started")
    const outcome = outcomes[idxBefore]
    return { info, outcome }
  })
}

describe("checkpoint watermark is transactional (advances only on writer success)", () => {
  it.live(
    "writer FAILURE → last_checkpoint_message_id stays unchanged (delta re-covered next time)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const { info, outcome } = yield* seedAndStartWriter()

        // Precondition: no watermark yet (first checkpoint). lastBoundary
        // returns null (DB) when unset; normalize null/undefined to falsy.
        const before = yield* svc.lastBoundary(info.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
        expect(before ?? undefined).toBeUndefined()

        // Resolve THIS writer's outcome as FAILURE.
        yield* Deferred.succeed(outcome, { status: "failure", error: "boom" })

        // Give the detached settle watcher time to run. The watermark must NOT
        // advance — otherwise the un-checkpointed delta would be silently
        // skipped by the next rebuild.
        yield* Effect.sleep("500 millis")
        const after = yield* svc.lastBoundary(info.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
        expect(after ?? undefined).toBeUndefined()
      }),
    ),
  )

  it.live(
    "writer SUCCESS → last_checkpoint_message_id advances",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const { info, outcome } = yield* seedAndStartWriter()

        const before = yield* svc.lastBoundary(info.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
        expect(before ?? undefined).toBeUndefined()

        // Resolve THIS writer's outcome as SUCCESS.
        yield* Deferred.succeed(outcome, { status: "success" } as AgentOutcome)

        // Poll lastBoundary until the detached settle watcher writes the DB
        // (the watermark advance is not synchronous with resolving the outcome).
        let wm: MessageID | undefined
        for (let i = 0; i < 40; i++) {
          wm = yield* svc.lastBoundary(info.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (wm) break
          yield* Effect.sleep("50 millis")
        }
        expect(wm).toBeTruthy()
      }),
    ),
  )
})
