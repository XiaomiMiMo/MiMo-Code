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
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as fs from "fs/promises"
import path from "path"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

// Controllable actor: each spawn's outcome Deferred is captured so the test can
// resolve it success/failure on demand and drive the rebuild-decision logic.
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
    return { info, outcome: outcomes[idxBefore] }
  })
}

// When no usable checkpoint exists yet (watermark unset) and the first writer
// is in-flight, renderRebuildContext AWAITS the writer (bounded) rather than
// rebuilding off the mid-write bootstrap template. After the writer settles it
// renders normally: on success the fresh checkpoint is on disk; on failure it
// falls through to whatever else exists, and returns "" (→ caller compacts)
// only when there is genuinely nothing to rebuild from.
describe("rebuild waits for the first in-flight writer before rendering", () => {
  it.live(
    "no checkpoint + writer in-flight → renderRebuildContext blocks on the writer (doesn't rebuild off the template)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const { info } = yield* seedAndStartWriter()
        // Do NOT resolve the writer. With no watermark yet and a hanging writer,
        // the rebuild must be waiting — a bounded observation shows it still
        // pending (None), proving it doesn't rebuild off the template mid-write.
        const result = yield* svc
          .renderRebuildContext(info.id, { agentID: "main" })
          .pipe(Effect.timeout("2 seconds"), Effect.option)
        expect(result._tag).toBe("None")
      }),
    ),
  )

  it.live(
    "no checkpoint + first writer SUCCEEDS (watermark advances) → renderRebuildContext returns content",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const { info, outcome } = yield* seedAndStartWriter()

        // Simulate the writer's final step: write a real checkpoint file, then
        // settle SUCCESS (the settle watcher advances the watermark on success).
        const cpPath = checkpointPath(info.id)
        yield* Effect.promise(() => fs.mkdir(path.dirname(cpPath), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(cpPath, "# Session checkpoint\n\n## §1 Active intent\nReal distilled content.\n"),
        )
        yield* Deferred.succeed(outcome, { status: "success" } as AgentOutcome)
        yield* Effect.sleep("500 millis") // let the settle watcher advance the watermark

        const ctx = yield* svc
          .renderRebuildContext(info.id, { agentID: "main" })
          .pipe(Effect.catch(() => Effect.succeed("")))
        expect(ctx.length).toBeGreaterThan(0)
      }),
    ),
  )
})
