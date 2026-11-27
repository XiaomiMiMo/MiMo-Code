import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { Plugin } from "../../src/plugin"
import { TaskRegistry } from "../../src/task/registry"
import { CheckpointWriterModel } from "../../src/session/checkpoint-writer-model"
import { Provider } from "../../src/provider"
import { ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const env = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  Memory.defaultLayer,
  TaskRegistry.defaultLayer,
  infra,
)

const it = testEffect(env)

describe("checkpoint writer model pin", () => {
  it.live(
    "a literal agent.checkpoint-writer.model is the model the writer is pinned to",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          const provider = yield* Provider.Service
          expect(yield* CheckpointWriterModel.resolve(agents, provider)()).toEqual({
            providerID: "pin-provider",
            modelID: "pin-model",
          })
        }),
      { config: { agent: { "checkpoint-writer": { model: "pin-provider/pin-model" } } } },
    ),
  )

  it.live(
    "a bare tier name is resolved against the parent session's provider",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          const provider = yield* Provider.Service
          // ProviderTest's fake provider resolves any bare tier to its one model.
          expect(yield* CheckpointWriterModel.resolve(agents, provider)("openai")).toEqual({
            providerID: "openai",
            modelID: "gpt-5.2",
          })
        }),
      { config: { agent: { "checkpoint-writer": { model: "lite" } } } },
    ),
  )

  it.live(
    "yields nothing when the writer agent pins no model, so callers keep inheriting",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          const provider = yield* Provider.Service
          expect(yield* CheckpointWriterModel.resolve(agents, provider)(ProviderID.make("session-provider"))).toBeUndefined()
        }),
      { config: {} },
    ),
  )
})
