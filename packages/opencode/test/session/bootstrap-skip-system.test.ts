import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { ActorRegistry } from "../../src/actor/registry"
import { Actor } from "../../src/actor/spawn"
import { TaskRegistry } from "../../src/task/registry"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const stubActorRegistry = Layer.succeed(
  ActorRegistry.Service,
  ActorRegistry.Service.of({
    register: () => Effect.die("not used"),
    updateStatus: () => Effect.void,
    updateTurn: () => Effect.void,
    updateAgent: () => Effect.void,
    get: () => Effect.succeed(undefined),
    liveness: () => Effect.succeed(undefined),
    listBySession: () => Effect.succeed([]),
    listActive: () => Effect.succeed([]),
    listByParent: () => Effect.succeed([]),
    renderForAgent: () => Effect.succeed(""),
    agentTypeFor: () => Effect.succeed("main"),
    // Force the guard inside tryStartCheckpointWriter to fire by always reporting true.
    isSystemSpawned: () => Effect.succeed(true),
    // System actor → does not serve checkpoint (mirrors isSystemSpawned=true here).
    servesCheckpoint: () => Effect.succeed(false),
    allocateActorID: () => Effect.die("not used"),
  }),
)

// The system-spawn guard short-circuits before Actor.spawn is reached, so this
// stub never gets called — but we still need to satisfy the SessionCheckpoint
// layer's Actor.Service requirement at construction time.
const stubActor = Layer.succeed(
  Actor.Service,
  Actor.Service.of({
    spawn: () => Effect.die("Actor.spawn unexpectedly called in system-spawn skip path"),
    cancel: () => Effect.die("Actor.cancel unexpectedly called in system-spawn skip path"),
    getForkContext: () => Effect.succeed(undefined),
  }),
)

const deps = Layer.mergeAll(
  Bus.layer,
  Config.defaultLayer,
  Memory.defaultLayer,
  TaskRegistry.defaultLayer,
  stubActorRegistry,
  stubActor,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

describe("SessionCheckpoint.tryStartCheckpointWriter — system-spawn skip", () => {
  test("returns 'skipped' and does NOT bootstrap checkpoint.md when isSystemSpawned=true", async () => {
    await Effect.runPromise(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const svc = yield* SessionCheckpoint.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})

          // Seed enough state that the empty-message guard would not fire — so
          // we know it's the system-spawn guard short-circuiting the bootstrap.
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

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as any,
          })
          expect(outcome).toBe("skipped")

          // Bootstrap helpers (ensureCheckpointTemplate / ensureMemoryTemplate)
          // run AFTER the system-spawn guard. With the guard active, no
          // checkpoint.md should appear on disk.
          const cpPath = checkpointPath(info.id)
          const exists = yield* Effect.promise(() =>
            fs.stat(cpPath).then(() => true).catch(() => false),
          )
          expect(exists).toBe(false)

          // Sanity: the writer table should not have been updated either.
          const running = yield* svc.isWriterRunning(info.id)
          expect(running).toBe(false)
        }),
      ).pipe(Effect.scoped, Effect.provide(env)),
    )
  })
})
