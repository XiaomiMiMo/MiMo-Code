import { Database, eq, and } from "../../src/storage"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID } from "../../src/session/schema"
import { ActorStatusChanged } from "../../src/actor/events"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, ManagedRuntime } from "effect"
import { Instance } from "../../src/project/instance"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { runTurn } from "../../src/actor/turn"
import { tmpdir } from "../fixture/fixture"

const testLayer = Layer.mergeAll(ActorRegistry.defaultLayer, Bus.defaultLayer, Session.defaultLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

async function withTurn(
  directory: string,
  fn: (rt: ManagedRuntime.ManagedRuntime<ActorRegistry.Service | Bus.Service | Session.Service, never>) => Promise<void>,
) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(testLayer)
      try {
        await fn(rt)
      } finally {
        await rt.dispose()
      }
    },
  })
}

describe("runTurn (Plan 1 / Task 3)", () => {
  test("running → idle / success when work succeeds", async () => {
    await using tmp = await tmpdir({ git: true })
    await withTurn(tmp.path, async (rt) => {
      const parent = await rt.runPromise(Session.Service.use((s) => s.create()))
      const sid = parent.id
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: sid,
            actorID: "turn-actor-a",
            mode: "subagent",
            parentActorID: undefined,
            agent: "main",
            description: "main",
            contextMode: "full",
            contextWatermark: undefined,
            background: false,
            lifecycle: "persistent",
          }),
        ),
      )
      const result = await rt.runPromise(runTurn(sid, "turn-actor-a", Effect.succeed("hello")))
      expect(result).toBe("hello")
      const entry = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.get(sid, "turn-actor-a")))
      expect(entry?.status).toBe("idle")
      expect(entry?.lastOutcome).toBe("success")
      expect(entry?.lastError).toBeUndefined()
    })
  })

  test("running → idle / failure with last_error on Effect.fail", async () => {
    await using tmp = await tmpdir({ git: true })
    await withTurn(tmp.path, async (rt) => {
      const parent = await rt.runPromise(Session.Service.use((s) => s.create()))
      const sid = parent.id
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: sid,
            actorID: "turn-actor-b",
            mode: "subagent",
            parentActorID: undefined,
            agent: "main",
            description: "main",
            contextMode: "full",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          }),
        ),
      )
      const exit = await rt.runPromise(runTurn(sid, "turn-actor-b", Effect.fail(new Error("boom"))).pipe(Effect.exit))
      expect(exit._tag).toBe("Failure")
      const entry = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.get(sid, "turn-actor-b")))
      expect(entry?.status).toBe("idle")
      expect(entry?.lastOutcome).toBe("failure")
      expect(entry?.lastError).toContain("boom")
    })
  })

  test("running → idle / cancelled on Fiber.interrupt", async () => {
    await using tmp = await tmpdir({ git: true })
    await withTurn(tmp.path, async (rt) => {
      const parent = await rt.runPromise(Session.Service.use((s) => s.create()))
      const sid = parent.id
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: sid,
            actorID: "turn-actor-c",
            mode: "subagent",
            parentActorID: undefined,
            agent: "main",
            description: "main",
            contextMode: "full",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          }),
        ),
      )
      const fiber = rt.runFork(runTurn(sid, "turn-actor-c", Effect.never))
      await new Promise((res) => setTimeout(res, 50))
      await rt.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore))
      await new Promise((res) => setTimeout(res, 100))
      const entry = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.get(sid, "turn-actor-c")))
      expect(entry?.status).toBe("idle")
      expect(entry?.lastOutcome).toBe("cancelled")
      expect(entry?.lastError).toBeUndefined()
    })
  })
})

const generationTests = testEffect(Layer.mergeAll(testLayer, CrossSpawnSpawner.defaultLayer))

// [TP-R23-05] Durable creation source and a generation per execution, not per model step.
generationTests.live("persists actor source and advances generations independently of step counts", () =>
  provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const reg = yield* ActorRegistry.Service
    const session = yield* sessions.create()
    const source = { sourceSessionID: session.id, sourceCallID: "call-example", sourceTurnID: MessageID.ascending() }
    const actor = yield* reg.register({ sessionID: session.id, actorID: "example-actor", mode: "subagent",
      parentActorID: "main", agent: "general", description: "example", contextMode: "none",
      background: true, lifecycle: "persistent", source })
    expect(actor.executionGeneration).toBeUndefined()
    expect(yield* reg.get(session.id, actor.actorID)).toMatchObject(source)
    yield* runTurn(session.id, actor.actorID, Effect.gen(function* () {
      expect((yield* reg.get(session.id, actor.actorID))?.executionGeneration).toBe("1")
      yield* reg.updateTurn(session.id, actor.actorID)
      yield* reg.updateTurn(session.id, actor.actorID)
      expect((yield* reg.get(session.id, actor.actorID))?.executionGeneration).toBe("1")
    }))
    expect(yield* reg.get(session.id, actor.actorID)).toMatchObject({ ...source, executionGeneration: "1", status: "idle", lastOutcome: "success" })
    yield* runTurn(session.id, actor.actorID, Effect.void)
    expect(yield* reg.get(session.id, actor.actorID)).toMatchObject({ ...source, executionGeneration: "2", turnCount: 2, status: "idle" })
  })),
)

// [TP-R23-05] A superseded turn must not publish or persist its terminal state.
generationTests.live("ignores old and unversioned settlement after a newer execution has started", () =>
  provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const reg = yield* ActorRegistry.Service
    const bus = yield* Bus.Service
    const session = yield* sessions.create()
    const actorID = "example-actor"
    yield* reg.register({ sessionID: session.id, actorID, mode: "subagent", agent: "general",
      description: "example", contextMode: "none", background: true, lifecycle: "persistent" })
    const events: { status: string; executionGeneration?: string }[] = []
    const delivered = Promise.withResolvers<void>()
    const unsubscribe = yield* bus.subscribeCallback(ActorStatusChanged, event => {
      events.push(event.properties)
      if (event.properties.executionGeneration === "2" && event.properties.status === "running") delivered.resolve()
    })
    yield* runTurn(session.id, actorID, Effect.gen(function* () {
      expect(yield* reg.beginExecution(session.id, actorID)).toBe("2")
    }))
    yield* reg.updateStatus(session.id, actorID, { expectedGeneration: null, status: "idle", lastOutcome: "cancelled" })
    expect(yield* reg.get(session.id, actorID)).toMatchObject({ executionGeneration: "2", status: "running" })
    yield* Effect.promise(() => delivered.promise).pipe(Effect.timeout("2 seconds"))
    expect(events).toEqual([expect.objectContaining({ status: "running", executionGeneration: "1" }),
      expect.objectContaining({ status: "running", executionGeneration: "2" })])
    yield* reg.updateStatus(session.id, actorID, { status: "idle", lastOutcome: "success", expectedGeneration: "2" })
    expect(yield* reg.get(session.id, actorID)).toMatchObject({ executionGeneration: "2", status: "idle", lastOutcome: "success" })
    unsubscribe()
  })),
)

// [TP-R23-05] Legacy imported sessions need a root, not invented child identities.
generationTests.live("admits a legacy main without inventing missing child actors", () =>
  provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const reg = yield* ActorRegistry.Service
    const session = yield* sessions.create()
    yield* Effect.sync(() => Database.use(db => db.delete(ActorRegistryTable)
      .where(and(eq(ActorRegistryTable.session_id, session.id), eq(ActorRegistryTable.actor_id, "main"))).run()))
    expect(yield* reg.get(session.id, "main")).toBeUndefined()
    yield* runTurn(session.id, "main", Effect.void)
    expect(yield* reg.get(session.id, "main")).toMatchObject({ actorID: "main", executionGeneration: "1", status: "idle", lastOutcome: "success" })
    yield* runTurn(session.id, "main", Effect.void)
    expect((yield* reg.get(session.id, "main"))?.executionGeneration).toBe("2")
    yield* runTurn(session.id, "missing-child", Effect.void)
    expect(yield* reg.get(session.id, "missing-child")).toBeUndefined()
  })),
)

// [TP-R23-05] A missing registry row is not an admission failure: runTurn keeps the
// pre-generation contract and still executes the work unversioned.
generationTests.live("runs the work and succeeds when the actor has no registry row", () =>
  provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const reg = yield* ActorRegistry.Service
    const session = yield* sessions.create()
    expect(yield* reg.beginExecution(session.id, "unregistered-child")).toBeUndefined()
    let ran = 0
    const exit = yield* runTurn(session.id, "unregistered-child", Effect.sync(() => ++ran && "work-result")).pipe(Effect.exit)
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBe("work-result")
    expect(ran).toBe(1)
    expect(yield* reg.get(session.id, "unregistered-child")).toBeUndefined()
  })),
)
