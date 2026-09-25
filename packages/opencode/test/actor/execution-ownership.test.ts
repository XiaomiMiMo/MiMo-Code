import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { ActorExecution } from "../../src/actor/execution"
import { WorkspaceID } from "../../src/control-plane/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { WorkspaceRef } from "../../src/effect/instance-ref"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, ActorExecution.layer, CrossSpawnSpawner.defaultLayer))
const oldWorkspace = WorkspaceID.make("wrk_actor_reserved_owner")
const newWorkspace = WorkspaceID.make("wrk_actor_replacement_owner")
const move = (sessionID: SessionID, workspaceID: WorkspaceID) => Effect.sync(() => Database.use((db) =>
  db.update(SessionTable).set({ workspace_id: workspaceID }).where(eq(SessionTable.id, sessionID)).run(),
))

afterEach(() => Instance.disposeAll())

const rejectionHooks: Record<string, () => Effect.Effect<void>> = {
  "synchronous throw": () => { throw new Error("hook construction failed") },
  "Effect failure": () => Effect.fail(new Error("hook effect failed")) as unknown as Effect.Effect<void>,
  "Effect defect": () => Effect.die(new Error("hook effect defect")),
  "explicit interrupt": () => Effect.interrupt,
}

describe("ActorExecution work ownership", () => {
  for (const entry of ["reserve", "acquire"] as const) {
    it.live(`${entry} retains the original identity through delayed fork and releases a rejected reservation`, provideTmpdirInstance(() => Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({})
      const actors = yield* ActorExecution.Service
      const scope = yield* Scope.Scope
      yield* move(session.id, oldWorkspace)
      const execution = yield* actors[entry](session.id, "actor").pipe(Effect.provideService(WorkspaceRef, oldWorkspace))
      yield* move(session.id, newWorkspace)
      let ran = false
      const fiber = yield* actors.fork(execution, Effect.sync(() => { ran = true }), scope)
        .pipe(Effect.provideService(WorkspaceRef, newWorkspace))
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(ran).toBe(false)
      expect(yield* Deferred.isDone(execution.done)).toBe(true)
      expect(actors.currentUnsafe(session.id, "actor")).toBeUndefined()
      expect(actors.hasActiveUnsafe(session.id)).toBe(false)
    })), 30000)

    it.live(`${entry} rejects stale attach and settles the reservation without publishing a fiber`, provideTmpdirInstance(() => Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({})
      const actors = yield* ActorExecution.Service
      yield* move(session.id, oldWorkspace)
      const execution = yield* actors[entry](session.id, "actor").pipe(Effect.provideService(WorkspaceRef, oldWorkspace))
      yield* move(session.id, newWorkspace)
      const exit = yield* actors.attach(execution).pipe(Effect.provideService(WorkspaceRef, newWorkspace), Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(execution.fiber).toBeUndefined()
      expect(yield* Deferred.isDone(execution.done)).toBe(true)
      expect(actors.hasActiveUnsafe(session.id)).toBe(false)
    })), 30000)

    it.live(`${entry} rejects a stale fork without releasing or cancelling the new owner's execution`, provideTmpdirInstance(() => Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({})
      const actors = yield* ActorExecution.Service
      const scope = yield* Scope.Scope
      yield* move(session.id, oldWorkspace)
      const old = yield* actors[entry](session.id, "actor").pipe(Effect.provideService(WorkspaceRef, oldWorkspace))
      yield* actors.release(old)
      yield* move(session.id, newWorkspace)
      const current = yield* actors[entry](session.id, "actor").pipe(Effect.provideService(WorkspaceRef, newWorkspace))
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const active = yield* actors.fork(current,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish)), Effect.ensuring(actors.release(current))),
        scope,
      ).pipe(Effect.provideService(WorkspaceRef, newWorkspace))
      yield* Deferred.await(started)
      let staleRan = false
      const stale = yield* actors.fork(old, Effect.sync(() => { staleRan = true }), scope)
        .pipe(Effect.provideService(WorkspaceRef, newWorkspace))
      expect(Exit.isFailure(yield* Fiber.await(stale))).toBe(true)
      expect(staleRan).toBe(false)
      expect(actors.currentUnsafe(session.id, "actor")).toBe(current)
      expect(current.cancelled).toBe(false)
      expect(yield* Deferred.isDone(current.done)).toBe(false)
      expect(active.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(finish, undefined)
      expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
      expect(actors.hasActiveUnsafe(session.id)).toBe(false)
    })), 30000)
  }

  for (const [name, hook] of Object.entries(rejectionHooks)) {
    it.live(`${name} in a rejection hook still releases the reservation and completes done`, provideTmpdirInstance(() => Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({})
      const actors = yield* ActorExecution.Service
      const scope = yield* Scope.Scope
      yield* move(session.id, oldWorkspace)
      const execution = yield* actors.reserve(session.id, "actor").pipe(Effect.provideService(WorkspaceRef, oldWorkspace))
      yield* move(session.id, newWorkspace)
      let ran = false
      let calls = 0
      const fiber = yield* actors.fork(execution, Effect.sync(() => { ran = true }), scope, () => {
        calls++
        return hook()
      }).pipe(Effect.provideService(WorkspaceRef, newWorkspace))
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(calls).toBe(1)
      expect(ran).toBe(false)
      expect(yield* Deferred.isDone(execution.done)).toBe(true)
      expect(actors.currentUnsafe(session.id, "actor")).toBeUndefined()
      expect(actors.hasActiveUnsafe(session.id)).toBe(false)
    })), 30000)

    it.live(`${name} in an old rejection hook does not release the new execution at the same key`, provideTmpdirInstance(() => Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({})
      const actors = yield* ActorExecution.Service
      const scope = yield* Scope.Scope
      yield* move(session.id, oldWorkspace)
      const old = yield* actors.acquire(session.id, "actor").pipe(Effect.provideService(WorkspaceRef, oldWorkspace))
      yield* actors.release(old)
      yield* move(session.id, newWorkspace)
      const current = yield* actors.acquire(session.id, "actor").pipe(Effect.provideService(WorkspaceRef, newWorkspace))
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const active = yield* actors.fork(current,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish)), Effect.ensuring(actors.release(current))), scope,
      ).pipe(Effect.provideService(WorkspaceRef, newWorkspace))
      yield* Deferred.await(started)
      let ran = false
      const stale = yield* actors.fork(old, Effect.sync(() => { ran = true }), scope, hook)
        .pipe(Effect.provideService(WorkspaceRef, newWorkspace))
      expect(Exit.isFailure(yield* Fiber.await(stale))).toBe(true)
      expect(ran).toBe(false)
      expect(yield* Deferred.isDone(old.done)).toBe(true)
      expect(actors.currentUnsafe(session.id, "actor")).toBe(current)
      expect(current.cancelled).toBe(false)
      expect(yield* Deferred.isDone(current.done)).toBe(false)
      expect(active.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(finish, undefined)
      expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
      expect(actors.hasActiveUnsafe(session.id)).toBe(false)
    })), 30000)
  }
})
