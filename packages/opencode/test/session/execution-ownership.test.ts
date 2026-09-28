import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { ActorExecution } from "../../src/actor/execution"
import { WorkspaceID } from "../../src/control-plane/schema"
import { InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { InstanceState } from "../../src/effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { ExecutionOwnership } from "../../src/session/execution-ownership"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionRunState } from "../../src/session/run-state"
import { SessionID, MessageID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, SessionRunState.defaultLayer, ActorExecution.layer, CrossSpawnSpawner.defaultLayer))
const oldWorkspace = WorkspaceID.make("wrk_old_execution_owner")
const newWorkspace = WorkspaceID.make("wrk_new_execution_owner")

const move = (sessionID: SessionID, workspaceID: WorkspaceID | null, directory?: string) => Effect.sync(() =>
  Database.use((db) => db.update(SessionTable).set({ workspace_id: workspaceID, ...(directory ? { directory } : {}) })
    .where(eq(SessionTable.id, sessionID)).run()),
)

const result = (sessionID: SessionID): MessageV2.WithParts => ({
  info: {
    id: MessageID.ascending(), sessionID, agentID: "main", role: "user", time: { created: Date.now() },
    agent: "build", model: { providerID: "test", modelID: "test" },
  } as MessageV2.User,
  parts: [],
})

afterEach(() => Instance.disposeAll())

describe("execution ownership", () => {
  it.live("captures the caller's real instance and workspace without inheriting the session owner", provideTmpdirInstance((directory) => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({})
    yield* move(session.id, newWorkspace)
    expect(yield* ExecutionOwnership.captureIdentity).toEqual({ directory, workspaceID: undefined })
    const context = yield* InstanceState.context
    const identity = yield* ExecutionOwnership.captureIdentity.pipe(
      Effect.provideService(InstanceRef, { ...context, directory: `${directory}/caller` }),
      Effect.provideService(WorkspaceRef, oldWorkspace),
    )
    expect(identity).toEqual({ directory: `${directory}/caller`, workspaceID: oldWorkspace })
    expect(Database.use((db) => ExecutionOwnership.isOwned(db, session.id, identity))).toBe(false)
  })), 30000)

  it.live("matches workspace IDs even at one local directory and falls back to directory only for unowned sessions", provideTmpdirInstance((directory) => Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({})
    const owned = (identity: ExecutionOwnership.Identity) => Database.use((db) => ExecutionOwnership.isOwned(db, session.id, identity))
    expect(owned({ directory })).toBe(true)
    expect(owned({ directory, workspaceID: oldWorkspace })).toBe(false)
    expect(owned({ directory, workspaceID: newWorkspace })).toBe(false)
    expect(owned({ directory: `${directory}/other` })).toBe(false)
    yield* move(session.id, oldWorkspace)
    expect(owned({ directory, workspaceID: oldWorkspace })).toBe(true)
    expect(owned({ directory, workspaceID: newWorkspace })).toBe(false)
    expect(owned({ directory })).toBe(false)
    expect(() => Database.use((db) => ExecutionOwnership.assertOwnership(db, session.id, { directory, workspaceID: newWorkspace })))
      .toThrow(ExecutionOwnership.OwnershipError)
    expect(Database.use((db) => ExecutionOwnership.isOwned(db, SessionID.make("ses_missing_owner"), { directory }))).toBe(false)
    yield* move(session.id, null, `${directory}/other`)
    expect(owned({ directory, workspaceID: oldWorkspace })).toBe(false)
    expect(owned({ directory: `${directory}/other` })).toBe(true)
  })), 30000)

  it.live("reads ownership from the supplied transaction without mutating or committing it", provideTmpdirInstance((directory) => Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({})
    const identity = { directory }
    expect(() => Database.transaction((db) => {
      db.update(SessionTable).set({ workspace_id: newWorkspace }).where(eq(SessionTable.id, session.id)).run()
      expect(ExecutionOwnership.isOwned(db, session.id, identity)).toBe(false)
      ExecutionOwnership.assertOwnership(db, session.id, identity)
    })).toThrow(ExecutionOwnership.OwnershipError)
    expect(Database.use((db) => ExecutionOwnership.isOwned(db, session.id, identity))).toBe(true)
  })), 30000)

  for (const entry of ["start", "startOwned", "ensureRunning", "ensureExclusive", "startShell"] as const) {
    it.live(`${entry} rejects an old caller without disturbing the new owner's live run`, provideTmpdirInstance(() => Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({})
      const runs = yield* SessionRunState.Service
      yield* move(session.id, newWorkspace)
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<MessageV2.WithParts>()
      const current = yield* runs.ensureRunning(session.id, "main", Effect.interrupt,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ).pipe(Effect.provideService(WorkspaceRef, newWorkspace), Effect.forkChild)
      yield* Deferred.await(started)
      const snapshot = yield* runs.executionSnapshot(session.id, "main")
      let staleRan = false
      const work = Effect.sync(() => { staleRan = true; return result(session.id) })
      const call = entry === "startShell"
        ? runs.startShell(session.id, Effect.interrupt, work)
        : runs[entry](session.id, "main", Effect.interrupt, work)
      const denied = yield* call.pipe(Effect.provideService(WorkspaceRef, oldWorkspace), Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      expect(staleRan).toBe(false)
      expect(snapshot.isCurrent()).toBe(true)
      expect(current.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(finish, result(session.id))
      expect(Exit.isSuccess(yield* Fiber.await(current))).toBe(true)
    })), 30000)
  }

  it.live("rejects a delayed old waiter before it can acquire a replacement lease", provideTmpdirInstance(() => Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({})
    const runs = yield* SessionRunState.Service
    yield* move(session.id, oldWorkspace)
    const started = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<MessageV2.WithParts>()
    const current = yield* runs.ensureRunning(session.id, "main", Effect.interrupt,
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    ).pipe(Effect.provideService(WorkspaceRef, oldWorkspace), Effect.forkChild)
    yield* Deferred.await(started)
    let staleRan = false
    const delayed = yield* runs.ensureRunning(session.id, "main", Effect.interrupt,
      Effect.sync(() => { staleRan = true; return result(session.id) }),
    ).pipe(Effect.provideService(WorkspaceRef, oldWorkspace), Effect.forkChild)
    yield* Effect.yieldNow
    yield* move(session.id, newWorkspace)
    const newStarted = yield* Deferred.make<void>()
    const newFinish = yield* Deferred.make<MessageV2.WithParts>()
    const newRun = yield* runs.ensureRunning(session.id, "actor-new", Effect.interrupt,
      Deferred.succeed(newStarted, undefined).pipe(Effect.andThen(Deferred.await(newFinish))),
    ).pipe(Effect.provideService(WorkspaceRef, newWorkspace), Effect.forkChild)
    yield* Deferred.await(newStarted)
    yield* Deferred.succeed(finish, result(session.id))
    yield* Fiber.await(current)
    expect(Exit.isFailure(yield* Fiber.await(delayed))).toBe(true)
    expect(staleRan).toBe(false)
    expect(newRun.pollUnsafe()).toBeUndefined()
    const replacement = yield* runs.startOwned(session.id, "main", Effect.interrupt, Effect.never)
      .pipe(Effect.provideService(WorkspaceRef, newWorkspace))
    expect(replacement.runId).toBe(2)
    yield* replacement.interruptOwned
    yield* Deferred.succeed(newFinish, result(session.id))
    expect(Exit.isSuccess(yield* Fiber.await(newRun))).toBe(true)
  })), 30000)

  it.live("the session idle snapshot dynamically includes every lane, including cancellation finalizers", provideTmpdirInstance(() => Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({})
    const runs = yield* SessionRunState.Service
    const snapshot = yield* runs.sessionExecutionSnapshot(session.id)
    expect(snapshot.isIdle()).toBe(true)
    const started = yield* Deferred.make<void>()
    const exiting = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const actor = yield* runs.ensureRunning(session.id, "actor-only", Effect.interrupt,
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(
        Deferred.succeed(exiting, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      )),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    expect(snapshot.isIdle()).toBe(false)
    const cancel = yield* runs.cancelActor(session.id, "actor-only").pipe(Effect.forkChild)
    yield* Deferred.await(exiting)
    expect(snapshot.isIdle()).toBe(false)
    yield* Deferred.succeed(finish, undefined)
    yield* Fiber.await(cancel)
    yield* Fiber.await(actor)
    expect(snapshot.isIdle()).toBe(true)
  })), 30000)

  it.live("actor reservations stay active through cancellation until release; stale acquire cannot take the new reservation", provideTmpdirInstance(() => Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({})
    const actors = yield* ActorExecution.Service
    yield* move(session.id, oldWorkspace)
    const old = yield* actors.reserve(session.id, "actor").pipe(Effect.provideService(WorkspaceRef, oldWorkspace))
    expect(actors.hasActiveUnsafe(session.id)).toBe(true)
    expect(actors.hasActiveUnsafe(SessionID.make(`${session.id}:child`))).toBe(false)
    const delayed = yield* actors.acquire(session.id, "actor").pipe(Effect.provideService(WorkspaceRef, oldWorkspace), Effect.forkChild)
    yield* Effect.yieldNow
    yield* actors.requestCancel(old)
    expect(actors.hasActiveUnsafe(session.id)).toBe(true)
    yield* move(session.id, newWorkspace)
    yield* actors.release(old)
    const current = yield* actors.reserve(session.id, "actor").pipe(Effect.provideService(WorkspaceRef, newWorkspace))
    expect(Exit.isFailure(yield* Fiber.await(delayed))).toBe(true)
    const denied = yield* actors.reserve(session.id, "other").pipe(Effect.provideService(WorkspaceRef, oldWorkspace), Effect.exit)
    expect(Exit.isFailure(denied)).toBe(true)
    expect(actors.currentUnsafe(session.id, "actor")).toBe(current)
    expect(current.cancelled).toBe(false)
    yield* actors.release(current)
    expect(actors.hasActiveUnsafe(session.id)).toBe(false)
  })), 30000)
})
