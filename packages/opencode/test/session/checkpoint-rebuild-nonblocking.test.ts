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
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Actor stub whose outcome NEVER resolves — a checkpoint writer that stays
// in-flight for the whole test. This lets us assert what renderRebuildContext
// does WHILE a writer is running, without a real (slow) LLM round-trip.
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

// Register an in-flight (hanging) writer for a fresh session. Inlined into each
// test's Effect.gen so svc/ssn carry their resolved service types (matching the
// pattern in checkpoint-drain.test.ts). Returns the created session info.
function seedSessionWithWriter() {
  return Effect.gen(function* () {
    const svc = yield* SessionCheckpoint.Service
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
    const started = yield* svc.tryStartCheckpointWriter({
      sessionID: info.id,
      model: { providerID: "test", modelID: "test-model" },
      promptOps: {} as never,
    })
    expect(started).toBe("started")
    return info
  })
}

describe("renderRebuildContext: waits (bounded) for an in-flight writer, then degrades", () => {
  it.live(
    "writer in-flight (real on-disk checkpoint) → waits for the writer rather than using the stale file immediately",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const info = yield* seedSessionWithWriter()

        // Real (non-template) checkpoint already on disk.
        const marker = "MARKER_ONDISK_CHECKPOINT_BODY"
        yield* Effect.promise(() =>
          fs.writeFile(checkpointPath(info.id), `# Session checkpoint\n\n## §1 Active intent\n${marker}\n`),
        )

        // Policy: prefer the freshest checkpoint — wait (bounded, REBUILD_WAIT_MS)
        // for the in-flight writer instead of using the possibly-stale file
        // immediately. The writer here hangs forever, so within a short
        // observation window the call must STILL be waiting (None), proving it
        // blocks on the writer rather than returning the stale on-disk body fast.
        const result = yield* svc
          .renderRebuildContext(info.id, { agentID: "main" })
          .pipe(Effect.timeout("2 seconds"), Effect.option)
        expect(result._tag).toBe("None")
      }),
    ),
  )

  it.live(
    "writer in-flight (template-only on disk) → also waits (won't rebuild from placeholders)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const info = yield* seedSessionWithWriter()

        // tryStartCheckpointWriter bootstrapped checkpoint.md from the bare
        // template; the file exists but has no distilled content. The wait
        // policy applies here too — bounded observation must show it still
        // waiting on the hanging writer, not returning a placeholder rebuild.
        const onDisk = yield* svc.hasCheckpoint(info.id)
        expect(onDisk).toBe(true)

        const result = yield* svc
          .renderRebuildContext(info.id, { agentID: "main" })
          .pipe(Effect.timeout("2 seconds"), Effect.option)
        expect(result._tag).toBe("None")
      }),
    ),
  )
})
