import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { SessionCheckpoint, type WriterOutcome } from "../../src/session/checkpoint"
import { SessionPrune } from "../../src/session/prune"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider"
import { ProviderTest } from "../fake/provider"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ActorRegistry } from "../../src/actor/registry"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function createModel(opts: { context: number; output: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
)

describe("SessionPrune.fireCheckpoints — system-spawn skip", () => {
  test("skips when agentID resolves to a checkpoint-writer actor (no enqueue)", async () => {
    const enqueueState = { count: 0 }

    const stubLayer = Layer.succeed(
      SessionCheckpoint.Service,
      SessionCheckpoint.Service.of({
        tryStartCheckpointWriter: () =>
          Effect.sync(() => {
            enqueueState.count++
            return "started" as const
          }),
        waitForWriter: () => Effect.succeed("no-writer" as WriterOutcome | "no-writer"),
        drainWriters: () => Effect.succeed({ drained: 0, timedOut: 0 }),
        hasCheckpoint: () => Effect.succeed(false),
        hasMemoryOrTasks: () => Effect.succeed(false),
        loadLatest: () => Effect.succeed(undefined),
        loadCheckpoints: () => Effect.succeed([]),
        renderIndex: () => Effect.succeed(""),
        renderRebuildContext: () => Effect.succeed(""),
        lastBoundary: () => Effect.succeed(undefined),
        isWriterRunning: () => Effect.succeed(false),
        insertRebuildBoundary: () => Effect.succeed(false),
      }),
    )

    const env = Layer.mergeAll(
      SessionNs.defaultLayer,
      ActorRegistry.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      SessionPrune.layer.pipe(
        Layer.provide(SessionNs.defaultLayer),
        Layer.provide(stubLayer),
        Layer.provide(ActorRegistry.defaultLayer),
        Layer.provideMerge(deps),
      ),
    )

    await Effect.runPromise(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const actors = yield* ActorRegistry.Service
          const prune = yield* SessionPrune.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          // Register a system-spawned (checkpoint-writer) actor.
          yield* actors.register({
            sessionID: info.id,
            actorID: "checkpoint-writer-1",
            mode: "subagent",
            agent: "checkpoint-writer",
            description: "writer fixture",
            contextMode: "full",
            background: true,
            lifecycle: "ephemeral",
          })

          // Tokens above the 50% threshold.
          const tokens = { input: 60_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

          // Call with the system-spawn actorID — guard should short-circuit.
          yield* prune.fireCheckpoints({
            sessionID: info.id,
            model,
            tokens,
            promptOps: {} as any,
            agentID: "checkpoint-writer-1",
          })

          expect(enqueueState.count).toBe(0)
        }),
      { config: { checkpoint: { thresholds: ["50%"] } } },
      ).pipe(Effect.scoped, Effect.provide(env)),
    )
  })

  test("skips when agentID resolves to a subagent (explore)", async () => {
    const enqueueState = { count: 0 }

    const stubLayer = Layer.succeed(
      SessionCheckpoint.Service,
      SessionCheckpoint.Service.of({
        tryStartCheckpointWriter: () =>
          Effect.sync(() => {
            enqueueState.count++
            return "started" as const
          }),
        waitForWriter: () => Effect.succeed("no-writer" as WriterOutcome | "no-writer"),
        drainWriters: () => Effect.succeed({ drained: 0, timedOut: 0 }),
        hasCheckpoint: () => Effect.succeed(false),
        hasMemoryOrTasks: () => Effect.succeed(false),
        loadLatest: () => Effect.succeed(undefined),
        loadCheckpoints: () => Effect.succeed([]),
        renderIndex: () => Effect.succeed(""),
        renderRebuildContext: () => Effect.succeed(""),
        lastBoundary: () => Effect.succeed(undefined),
        isWriterRunning: () => Effect.succeed(false),
        insertRebuildBoundary: () => Effect.succeed(false),
      }),
    )

    const env = Layer.mergeAll(
      SessionNs.defaultLayer,
      ActorRegistry.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      SessionPrune.layer.pipe(
        Layer.provide(SessionNs.defaultLayer),
        Layer.provide(stubLayer),
        Layer.provide(ActorRegistry.defaultLayer),
        Layer.provideMerge(deps),
      ),
    )

    await Effect.runPromise(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const actors = yield* ActorRegistry.Service
          const prune = yield* SessionPrune.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          // Register a normal subagent (explore) sharing the parent session.
          yield* actors.register({
            sessionID: info.id,
            actorID: "explore-1",
            mode: "subagent",
            agent: "explore",
            description: "explore fixture",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })

          // Tokens above the 50% threshold.
          const tokens = { input: 60_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

          // Call with the explore subagent's agentID — new mode gate should skip.
          yield* prune.fireCheckpoints({
            sessionID: info.id,
            model,
            tokens,
            promptOps: {} as any,
            agentID: "explore-1",
          })

          expect(enqueueState.count).toBe(0)
        }),
      { config: { checkpoint: { thresholds: ["50%"] } } },
      ).pipe(Effect.scoped, Effect.provide(env)),
    )
  })

  test("does NOT skip when agentID is undefined (main agent)", async () => {
    const enqueueState = { count: 0 }

    const stubLayer = Layer.succeed(
      SessionCheckpoint.Service,
      SessionCheckpoint.Service.of({
        tryStartCheckpointWriter: () =>
          Effect.sync(() => {
            enqueueState.count++
            return "started" as const
          }),
        waitForWriter: () => Effect.succeed("no-writer" as WriterOutcome | "no-writer"),
        drainWriters: () => Effect.succeed({ drained: 0, timedOut: 0 }),
        hasCheckpoint: () => Effect.succeed(false),
        hasMemoryOrTasks: () => Effect.succeed(false),
        loadLatest: () => Effect.succeed(undefined),
        loadCheckpoints: () => Effect.succeed([]),
        renderIndex: () => Effect.succeed(""),
        renderRebuildContext: () => Effect.succeed(""),
        lastBoundary: () => Effect.succeed(undefined),
        isWriterRunning: () => Effect.succeed(false),
        insertRebuildBoundary: () => Effect.succeed(false),
      }),
    )

    const env = Layer.mergeAll(
      SessionNs.defaultLayer,
      ActorRegistry.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      SessionPrune.layer.pipe(
        Layer.provide(SessionNs.defaultLayer),
        Layer.provide(stubLayer),
        Layer.provide(ActorRegistry.defaultLayer),
        Layer.provideMerge(deps),
      ),
    )

    await Effect.runPromise(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const prune = yield* SessionPrune.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          const tokens = { input: 60_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

          // No agentID: control case — guard should not fire, enqueue runs.
          yield* prune.fireCheckpoints({
            sessionID: info.id,
            model,
            tokens,
            promptOps: {} as any,
          })

          expect(enqueueState.count).toBe(1)
        }),
      { config: { checkpoint: { thresholds: ["50%"] } } },
      ).pipe(Effect.scoped, Effect.provide(env)),
    )
  })

  test("does NOT skip when agentID resolves to a peer", async () => {
    const enqueueState = { count: 0 }

    const stubLayer = Layer.succeed(
      SessionCheckpoint.Service,
      SessionCheckpoint.Service.of({
        tryStartCheckpointWriter: () =>
          Effect.sync(() => {
            enqueueState.count++
            return "started" as const
          }),
        waitForWriter: () => Effect.succeed("no-writer" as WriterOutcome | "no-writer"),
        drainWriters: () => Effect.succeed({ drained: 0, timedOut: 0 }),
        hasCheckpoint: () => Effect.succeed(false),
        hasMemoryOrTasks: () => Effect.succeed(false),
        loadLatest: () => Effect.succeed(undefined),
        loadCheckpoints: () => Effect.succeed([]),
        renderIndex: () => Effect.succeed(""),
        renderRebuildContext: () => Effect.succeed(""),
        lastBoundary: () => Effect.succeed(undefined),
        isWriterRunning: () => Effect.succeed(false),
        insertRebuildBoundary: () => Effect.succeed(false),
      }),
    )

    const env = Layer.mergeAll(
      SessionNs.defaultLayer,
      ActorRegistry.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      SessionPrune.layer.pipe(
        Layer.provide(SessionNs.defaultLayer),
        Layer.provide(stubLayer),
        Layer.provide(ActorRegistry.defaultLayer),
        Layer.provideMerge(deps),
      ),
    )

    await Effect.runPromise(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const actors = yield* ActorRegistry.Service
          const prune = yield* SessionPrune.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          // Register a peer actor (runs a long-lived loop; must keep checkpoints).
          yield* actors.register({
            sessionID: info.id,
            actorID: "researcher-1",
            mode: "peer",
            agent: "general",
            description: "peer fixture",
            contextMode: "none",
            background: true,
            lifecycle: "persistent",
          })

          // Tokens above the 50% threshold.
          const tokens = { input: 60_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

          // Call with the peer's agentID — peer is NOT a subagent, so it fires.
          yield* prune.fireCheckpoints({
            sessionID: info.id,
            model,
            tokens,
            promptOps: {} as any,
            agentID: "researcher-1",
          })

          expect(enqueueState.count).toBe(1)
        }),
      { config: { checkpoint: { thresholds: ["50%"] } } },
      ).pipe(Effect.scoped, Effect.provide(env)),
    )
  })
})
