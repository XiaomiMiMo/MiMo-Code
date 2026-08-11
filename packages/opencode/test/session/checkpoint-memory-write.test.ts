import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { Memory } from "../../src/memory"
import { ActorRegistry } from "../../src/actor/registry"
import { Actor, type AgentOutcome } from "../../src/actor/spawn"
import { spawnRef } from "../../src/actor/spawn-ref"
import { prefixCaptureRef } from "../../src/session/prefix-capture-ref"
import { TaskRegistry } from "../../src/task/registry"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { checkpointPath, notesPath, tasksDir } from "../../src/session/checkpoint-paths"
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

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Counts writer spawns so "writing off ⇒ no writer at all" is asserted on the
// spawn itself, not just on the absence of files. Mirrors the recordingActor in
// checkpoint-child-session.test.ts.
const spawnLog: { count: number } = { count: 0 }

const recordingActor = Layer.effect(
  Actor.Service,
  Effect.gen(function* () {
    const prevSpawnRef = spawnRef.current
    const impl = Actor.Service.of({
      spawn: (input) =>
        Effect.gen(function* () {
          spawnLog.count += 1
          const outcome = yield* Deferred.make<AgentOutcome>()
          return { actorID: `${input.agentType}-${spawnLog.count}`, sessionID: input.sessionID, outcome }
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
  recordingActor,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

const reset = Effect.sync(() => {
  spawnLog.count = 0
  prefixCaptureRef.current = undefined
})

const seedSession = Effect.fn("seedSession")(function* () {
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
  return info
})

describe("memory write gate (W1)", () => {
  it.live(
    "absent config → writer starts and memory files are bootstrapped (today's behavior)",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          const cp = yield* SessionCheckpoint.Service
          const info = yield* seedSession()

          const outcome = yield* cp.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as never,
          })

          expect(outcome).toBe("started")
          expect(spawnLog.count).toBe(1)
          expect(yield* Effect.promise(() => Bun.file(checkpointPath(info.id)).exists())).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(notesPath(info.id)).exists())).toBe(true)
        }),
      { outsideGit: true },
    ),
  )

  it.live(
    "disable_write: false → identical to absent config",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          const cp = yield* SessionCheckpoint.Service
          const info = yield* seedSession()

          const outcome = yield* cp.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as never,
          })

          expect(outcome).toBe("started")
          expect(spawnLog.count).toBe(1)
          expect(yield* Effect.promise(() => Bun.file(checkpointPath(info.id)).exists())).toBe(true)
        }),
      { outsideGit: true, config: { memory: { disable_write: false } } },
    ),
  )

  it.live(
    "disable_write: true → skipped, no writer spawned, no memory files created",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          const cp = yield* SessionCheckpoint.Service
          const info = yield* seedSession()

          const outcome = yield* cp.tryStartCheckpointWriter({
            sessionID: info.id,
            model: { providerID: "test", modelID: "test-model" },
            promptOps: {} as never,
          })

          expect(outcome).toBe("skipped")
          expect(spawnLog.count).toBe(0)
          // Nothing bootstrapped: no template, no notes, not even the session dir.
          expect(yield* Effect.promise(() => Bun.file(checkpointPath(info.id)).exists())).toBe(false)
          expect(yield* Effect.promise(() => Bun.file(notesPath(info.id)).exists())).toBe(false)
          const tasks = yield* Effect.promise(() =>
            fs.readdir(tasksDir(info.id)).catch(() => "ENOENT" as const),
          )
          expect(tasks === "ENOENT" || tasks.length === 0).toBe(true)
        }),
      { outsideGit: true, config: { memory: { disable_write: true } } },
    ),
  )
})

describe("the memory write switch leaves the READ path intact", () => {
  it.live(
    "disable_write: true → an existing checkpoint still produces rebuild context",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          const ssn = yield* SessionNs.Service
          const cp = yield* SessionCheckpoint.Service
          const info = yield* seedSession()

          // Memory written BEFORE the switch was flipped must keep feeding context.
          const cpPath = checkpointPath(info.id)
          yield* Effect.promise(() => fs.mkdir(path.dirname(cpPath), { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(cpPath, "# Session checkpoint\n\n## §1 Active intent\nOld intent survives.\n"),
          )

          const rendered = yield* cp.renderRebuildContext(info.id, { agentID: "main" })
          expect(rendered.length).toBeGreaterThan(0)
          expect(rendered).toContain("Old intent survives.")
        }),
      { outsideGit: true, config: { memory: { disable_write: true } } },
    ),
  )

  it.live(
    "disable_write: true → the memory search tool still finds pre-existing memory",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* reset
          const memory = yield* Memory.Service
          const root = yield* memory.root()
          const file = path.join(root, "sessions", "ses_write_probe", "notes.md")
          yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(file, "## [turn 1]\nzarquon deadlock discovered in the widget pipeline.\n"),
          )

          const hits = yield* memory.search({ query: "zarquon" })
          expect(hits.some((h) => h.path === file)).toBe(true)
        }),
      { outsideGit: true, config: { memory: { disable_write: true } } },
    ),
  )
})
