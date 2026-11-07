import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { Memory } from "../../src/memory"
import { ActorRegistry } from "../../src/actor/registry"
import { Actor, type AgentOutcome } from "../../src/actor/spawn"
import { spawnRef } from "../../src/actor/spawn-ref"
import { prefixCaptureRef, type PrefixCaptureFn } from "../../src/session/prefix-capture-ref"
import { checkpointWriterModelRef } from "../../src/session/checkpoint-writer-model-ref"
import { TaskRegistry } from "../../src/task/registry"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

// The parent session's model. Every seeded message runs on it, and it is what
// the writer inherits when its agent pins nothing.
const sessionRef = {
  providerID: ProviderID.make("session-provider"),
  modelID: ModelID.make("session-model"),
}

// The model a user pins through `agent.checkpoint-writer.model`.
const pinnedRef = {
  providerID: ProviderID.make("writer-provider"),
  modelID: ModelID.make("writer-model"),
}

// spawnLog records what actor.spawn was actually asked to run: the model, the
// mode, and the forkContext the writer would receive. captureLog records the
// prefix-capture call, which under the fork branch is built for the PARENT
// agent + model and under the cold-start branch for the writer's own agent.
const spawnLog: {
  calls: Array<{
    agentType: string
    mode: string
    model?: { providerID: string; modelID: string }
    forkContext?: { system: string[]; model?: { providerID: string; modelID: string } }
  }>
} = { calls: [] }
const captureLog: {
  calls: Array<{ agentName: string; providerID: string; modelID: string }>
} = { calls: [] }

const recordingActor = Layer.effect(
  Actor.Service,
  Effect.gen(function* () {
    const prevSpawnRef = spawnRef.current
    let counter = 0
    const impl = Actor.Service.of({
      spawn: (input) =>
        Effect.gen(function* () {
          counter += 1
          spawnLog.calls.push({
            agentType: input.agentType,
            mode: input.mode,
            model: input.model as { providerID: string; modelID: string } | undefined,
            forkContext: input.forkContext as
              | { system: string[]; model?: { providerID: string; modelID: string } }
              | undefined,
          })
          const outcome = yield* Deferred.make<AgentOutcome>()
          yield* Deferred.succeed(outcome, { status: "success", finalText: "ok" })
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

// Stands in for the real prefix capture: records the agent name and the model
// the prefix was built for, which is what tells fork and cold-start apart.
function installRecordingCapture() {
  const fn: PrefixCaptureFn = (input) =>
    Effect.sync(() => {
      captureLog.calls.push({
        agentName: input.agentName,
        providerID: input.providerID,
        modelID: input.modelID,
      })
      return {
        system: [`sys:${input.agentName}:${input.providerID}/${input.modelID}`],
        tools: {},
        inheritedMessages: [{ role: "user" as const, content: "canned" } as never],
        parentPermission: [],
      }
    })
  prefixCaptureRef.current = fn
}

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  Memory.defaultLayer,
  TaskRegistry.defaultLayer,
  ActorRegistry.defaultLayer,
  recordingActor,
)

// The resolver ref is process-global, like prefixCaptureRef. Other test files in
// the same bun process (checkpoint-drain) read it while their own layers are up,
// so a pin installed here must not survive this file: reset it for the duration
// of the layer and hand the previous value back when the layer closes.
const isolateWriterModelRef = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.sync(() => {
      const prev = checkpointWriterModelRef.current
      checkpointWriterModelRef.current = undefined
      return prev
    }),
    (prev) =>
      Effect.sync(() => {
        checkpointWriterModelRef.current = prev
      }),
  ),
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  isolateWriterModelRef,
  SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

const reset = Effect.sync(() => {
  spawnLog.calls = []
  captureLog.calls = []
  prefixCaptureRef.current = undefined
  checkpointWriterModelRef.current = undefined
})

// Stands in for the resolver SessionPrompt.layer installs: returns the model the
// checkpoint-writer agent is pinned to, or undefined when it pins nothing.
const installPin = (pin?: { providerID: string; modelID: string }) =>
  Effect.sync(() => {
    checkpointWriterModelRef.current = () => Effect.succeed(pin)
  })

const PAD = "x ".repeat(25_000)

// u1(text)/a1(tool)/u2(text)/a2(text): a plain session whose tail is long
// enough that the writer's watermark lands on u2, so both branches have a
// usable slice/delta.
const seedSession = Effect.fn("seedSession")(function* () {
  const ssn = yield* SessionNs.Service
  const info = yield* ssn.create({})
  const t0 = Date.now()

  const u1 = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: info.id,
    agent: "build",
    model: sessionRef,
    time: { created: t0 },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: u1.id,
    sessionID: info.id,
    type: "text",
    text: "u1 prompt",
  })

  const a1 = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: info.id,
    agent: "build",
    parentID: u1.id,
    providerID: sessionRef.providerID,
    modelID: sessionRef.modelID,
    mode: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: t0 + 1 },
    finish: "tool-calls",
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: a1.id,
    sessionID: info.id,
    type: "tool",
    tool: "read",
    callID: `call-${a1.id}`,
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: "",
      metadata: {},
      time: { start: t0 + 1, end: t0 + 2 },
    },
  })

  const u2 = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: info.id,
    agent: "build",
    model: sessionRef,
    time: { created: t0 + 3 },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: u2.id,
    sessionID: info.id,
    type: "text",
    text: PAD,
  })

  const a2 = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: info.id,
    agent: "build",
    parentID: u2.id,
    providerID: sessionRef.providerID,
    modelID: sessionRef.modelID,
    mode: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: t0 + 4 },
    finish: "stop",
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: a2.id,
    sessionID: info.id,
    type: "text",
    text: PAD,
  })

  return { info, u2 }
})

describe("checkpoint writer model", () => {
  it.live(
    "a pinned writer model is the model the writer runs on, not the session model",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          installRecordingCapture()
          yield* installPin(pinnedRef)

          const svc = yield* SessionCheckpoint.Service
          const { info } = yield* seedSession()

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: sessionRef.providerID, modelID: sessionRef.modelID },
            promptOps: {} as never,
          })
          expect(outcome).toBe("started")

          expect(spawnLog.calls.length).toBe(1)
          const spawn = spawnLog.calls[0]
          expect(spawn.agentType).toBe("checkpoint-writer")
          expect(spawn.model).toEqual({
            providerID: pinnedRef.providerID,
            modelID: pinnedRef.modelID,
          })
          // The fork branch captures the PARENT agent's system prompt for the
          // parent's model, so a distinct pin must take the cold-start branch,
          // whose prefix belongs to the writer's own agent and model.
          expect(spawn.forkContext?.model).toEqual({
            providerID: pinnedRef.providerID,
            modelID: pinnedRef.modelID,
          })
          expect(captureLog.calls.length).toBe(1)
          expect(captureLog.calls[0].agentName).toBe("checkpoint-writer")
          expect(captureLog.calls[0].providerID).toBe(pinnedRef.providerID)
          expect(captureLog.calls[0].modelID).toBe(pinnedRef.modelID)
        }),
      { config: {} },
    ),
  )

  it.live(
    "no pin keeps today's inheritance: session model, parent fork intact",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          installRecordingCapture()
          yield* installPin(undefined)

          const svc = yield* SessionCheckpoint.Service
          const { info } = yield* seedSession()

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: sessionRef.providerID, modelID: sessionRef.modelID },
            promptOps: {} as never,
          })
          expect(outcome).toBe("started")

          const spawn = spawnLog.calls[0]
          expect(spawn.model).toEqual({
            providerID: sessionRef.providerID,
            modelID: sessionRef.modelID,
          })
          // Fork branch captures the parent agent at the session model.
          expect(captureLog.calls[0].agentName).toBe("build")
          expect(captureLog.calls[0].providerID).toBe(sessionRef.providerID)
          expect(captureLog.calls[0].modelID).toBe(sessionRef.modelID)
        }),
      { config: {} },
    ),
  )

  it.live(
    "a pin that names the session's own model changes nothing",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          installRecordingCapture()
          yield* installPin(sessionRef)

          const svc = yield* SessionCheckpoint.Service
          const { info } = yield* seedSession()

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: sessionRef.providerID, modelID: sessionRef.modelID },
            promptOps: {} as never,
          })
          expect(outcome).toBe("started")

          const spawn = spawnLog.calls[0]
          expect(spawn.model).toEqual({
            providerID: sessionRef.providerID,
            modelID: sessionRef.modelID,
          })
          expect(captureLog.calls[0].agentName).toBe("build")
        }),
      { config: {} },
    ),
  )

  it.live(
    "an unset resolver (layer built without SessionPrompt) inherits the session model",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          installRecordingCapture()

          const svc = yield* SessionCheckpoint.Service
          const { info } = yield* seedSession()

          const outcome = yield* svc.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: sessionRef.providerID, modelID: sessionRef.modelID },
            promptOps: {} as never,
          })
          expect(outcome).toBe("started")

          expect(spawnLog.calls[0].model).toEqual({
            providerID: sessionRef.providerID,
            modelID: sessionRef.modelID,
          })
          expect(captureLog.calls[0].agentName).toBe("build")
        }),
      { config: {} },
    ),
  )
})
