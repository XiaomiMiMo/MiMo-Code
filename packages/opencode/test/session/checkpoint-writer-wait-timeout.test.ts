import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
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

// Actor stub whose outcome Deferred never resolves — a writer still grinding
// through LLM round-trips when the caller's bounded wait expires.
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
          return { actorID: `${input.agentType}-${counter}`, sessionID: input.sessionID, outcome }
        }),
      cancel: () => Effect.void,
      getForkContext: () => Effect.succeed(undefined),
    })
    spawnRef.current = impl
    yield* Effect.addFinalizer(
      () =>
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

describe("SessionCheckpoint.waitForWriter", () => {
  it.effect(
    "in-flight writer past the wait bound reports 'timeout', never 'failure'",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        // Writer needs at least one message to get past the empty-delta guard.
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

        const started = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(started).toBe("started")

        // Drive past the 5-minute internal bound on the TestClock. The writer's
        // Deferred is still unresolved, so the wait expires while the writer is
        // genuinely in flight.
        const fiber = yield* Effect.forkChild(svc.waitForWriter(info.id))
        yield* TestClock.adjust("6 minutes")
        const result = yield* Fiber.join(fiber)

        // Regression: this used to be "failure", which made the prune retry
        // watcher tick writerFailures and (after MAX_WRITER_FAILURES) trip
        // "gave up after max consecutive failures" — permanently disabling
        // checkpointing for a session whose writers were only slow.
        expect(result).toBe("timeout")
        expect(result).not.toBe("failure")
      }),
    ),
  )
})
