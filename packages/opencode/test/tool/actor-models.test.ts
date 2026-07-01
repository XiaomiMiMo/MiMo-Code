import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Provider } from "../../src/provider"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { MessageID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ActorTool } from "../../src/tool/actor"
import { ActorRegistry } from "../../src/actor/registry"
import { TaskRegistry } from "../../src/task/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { Team } from "../../src/team"
import { Truncate } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

afterEach(async () => {
  await Instance.disposeAll()
})

// One vision-capable model + one text-only model, exposed through Provider.list().
const visionModel = ProviderTest.model({
  id: ModelID.make("vision-1"),
  providerID: ProviderID.make("acme"),
  name: "Vision One",
  capabilities: {
    toolcall: true,
    attachment: true,
    reasoning: false,
    temperature: true,
    interleaved: false,
    input: { text: true, image: true, audio: false, video: false, pdf: true },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
})

const textModel = ProviderTest.model({
  id: ModelID.make("text-1"),
  providerID: ProviderID.make("acme"),
  name: "Text One",
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    interleaved: false,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
})

const visionRef = `${visionModel.providerID}/${visionModel.id}`
const textRef = `${textModel.providerID}/${textModel.id}`

// A provider Info holding both models under a single provider.
const providerInfo = ProviderTest.info(
  { id: ProviderID.make("acme"), models: { [visionModel.id]: visionModel, [textModel.id]: textModel } },
  visionModel,
)

// Provider layer whose list() returns the two-model provider. Only list() is
// exercised by the models branch; the other methods keep the fake defaults.
const twoModelProvider = ProviderTest.fake({
  model: visionModel,
  info: providerInfo,
  list: Effect.fn("TwoModelProvider.list")(() => Effect.succeed({ [providerInfo.id]: providerInfo })),
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Bus.layer,
    Config.defaultLayer,
    twoModelProvider.layer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    ActorRegistry.defaultLayer,
    ActorWaiter.layer.pipe(Layer.provide(Bus.layer), Layer.provide(ActorRegistry.defaultLayer), Layer.provide(Session.defaultLayer)),
    Team.defaultLayer,
    SessionCheckpoint.defaultLayer,
    TaskRegistry.defaultLayer,
  ),
)

function ctxFor(sessionID: SessionID) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    extra: {},
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("actor tool — models action", () => {
  it.live(
    "models lists all configured models (both refs, vision tagged)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const def = yield* (yield* ActorTool).init()

        const result = yield* def.execute({ operation: { action: "models" } }, ctxFor(chat.id))

        expect(result.output).toContain(visionRef)
        expect(result.output).toContain(textRef)
        expect(result.output).toContain(`${visionRef} (vision)`)
        expect(result.metadata.count).toBe(2)
        expect(result.metadata.total).toBe(2)
      }),
    ),
  )

  it.live(
    "models --vision lists only the vision-capable model",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const def = yield* (yield* ActorTool).init()

        const result = yield* def.execute({ operation: { action: "models", vision: true } }, ctxFor(chat.id))

        expect(result.output).toContain(visionRef)
        expect(result.output).not.toContain(textRef)
        expect(result.metadata.count).toBe(1)
        expect(result.metadata.vision).toBe(true)
      }),
    ),
  )

  it.live(
    "models --limit 1 caps the list and mentions more",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const def = yield* (yield* ActorTool).init()

        const result = yield* def.execute({ operation: { action: "models", limit: 1 } }, ctxFor(chat.id))

        expect(result.metadata.count).toBe(1)
        expect(result.metadata.total).toBe(2)
        expect(result.output).toContain("more")
      }),
    ),
  )
})
