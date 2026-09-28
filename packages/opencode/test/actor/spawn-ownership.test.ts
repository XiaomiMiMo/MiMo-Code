import { afterEach, describe, expect, spyOn } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { ActorExecution, type Execution } from "../../src/actor/execution"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { Actor, type ForkContext } from "../../src/actor/spawn"
import { ActorWaiter } from "../../src/actor/waiter"
import { WorkspaceID } from "../../src/control-plane/schema"
import { AppLayer } from "../../src/effect/app-runtime"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { WorkspaceRef } from "../../src/effect/instance-ref"
import { Inbox } from "../../src/inbox"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, type SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { and, Database, eq } from "../../src/storage"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(AppLayer, Inbox.defaultLayer, CrossSpawnSpawner.defaultLayer))
const oldWorkspace = WorkspaceID.make("wrk_spawn_old_owner")
const newWorkspace = WorkspaceID.make("wrk_spawn_new_owner")
const options = { git: true, config: { agent: { custom: { model: "alibaba/qwen-plus", mode: "subagent" as const, completionGate: false } } } }
const move = (sessionID: SessionID) => Effect.sync(() => Database.use((db) =>
  db.update(SessionTable).set({ workspace_id: newWorkspace }).where(eq(SessionTable.id, sessionID)).run(),
))
const context = (): ForkContext => ({
  system: ["captured parent prefix"], tools: {}, parentPermission: [], inheritedMessages: [],
  watermarkMsgID: MessageID.ascending(),
  model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
})

afterEach(() => Instance.disposeAll())

describe("spawn ownership before detached work", () => {
  for (const mode of ["subagent", "peer"] as const) {
    it.live(`${mode} rejects delayed work, clears its context, and resolves outcome and wait without notification`, provideTmpdirInstance(() => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const actors = yield* Actor.Service
      const executions = yield* ActorExecution.Service
      const waiter = yield* ActorWaiter.Service
      const inbox = yield* Inbox.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({}).pipe(Effect.provideService(WorkspaceRef, oldWorkspace))
      const entered = yield* Deferred.make<Execution>()
      const resume = yield* Deferred.make<void>()
      const notify = yield* Deferred.make<boolean>()
      const forkContext = context()
      let workStarted = 0
      let rejected = 0
      const original = executions.fork
      const fork = spyOn(executions, "fork").mockImplementation((execution, work, scope, onRejected) =>
        Deferred.succeed(entered, execution).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.andThen(original(execution, Effect.sync(() => { workStarted++ }).pipe(Effect.andThen(work)), scope, (cause) => {
            rejected++
            return onRejected ? onRejected(cause) : Effect.void
          })),
        ),
      )
      const send = spyOn(inbox, "send")
      const unexpectedPrompt = spyOn(prompt, "prompt").mockImplementation(() => Effect.die(new Error("work must not start")))
      try {
        const pending = yield* actors.spawn({
          mode, sessionID: session.id, agentType: "custom", task: "do not execute after migration", context: "full",
          tools: [], background: true, forkContext, notifyOnCompletion: notify,
        }).pipe(Effect.provideService(WorkspaceRef, oldWorkspace), Effect.forkChild)
        const execution = yield* Deferred.await(entered)
        expect(yield* actors.getForkContext(execution.sessionID, execution.actorID)).toBe(forkContext)
        const waiting = yield* waiter.wait({ sessionID: execution.sessionID, actor_id: execution.actorID, timeout_ms: 5000 })
          .pipe(Effect.provideService(WorkspaceRef, oldWorkspace), Effect.forkChild)
        yield* Effect.yieldNow
        yield* move(execution.sessionID)
        yield* Deferred.succeed(resume, undefined)
        const child = yield* Fiber.join(pending)
        const outcome = yield* Deferred.await(child.outcome).pipe(Effect.timeout("2 seconds"))
        expect(outcome.status).toBe("failure")
        if (outcome.status === "failure") expect(outcome.error).toContain("Session execution is not owned")
        const waited = yield* Fiber.join(waiting).pipe(Effect.timeout("2 seconds"))
        expect(waited.executionActive).toBe(false)
        expect(waited.status).not.toBe("timeout")
        expect(rejected).toBe(1)
        expect(workStarted).toBe(0)
        expect(unexpectedPrompt).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
        expect(yield* Deferred.isDone(notify)).toBe(false)
        expect(yield* Deferred.isDone(execution.done)).toBe(true)
        expect(executions.hasActiveUnsafe(execution.sessionID)).toBe(false)
        expect(yield* actors.getForkContext(execution.sessionID, execution.actorID)).toBeUndefined()
        expect(Exit.isFailure(yield* Fiber.await(execution.fiber!))).toBe(true)
        expect(yield* sessions.messages({ sessionID: execution.sessionID, agentID: execution.actorID })).toEqual([])
        expect(yield* Deferred.await(child.outcome)).toBe(outcome)
      } finally {
        Deferred.doneUnsafe(resume, Effect.void)
        fork.mockRestore()
        send.mockRestore()
        unexpectedPrompt.mockRestore()
      }
    }), options), 30000)
  }

  it.live("old rejection cleanup preserves a replacement spawn's context, execution and outcome at the same actor key", provideTmpdirInstance(() => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const actors = yield* Actor.Service
    const executions = yield* ActorExecution.Service
    const registry = yield* ActorRegistry.Service
    const prompt = yield* SessionPrompt.Service
    const inbox = yield* Inbox.Service
    const session = yield* sessions.create({}).pipe(Effect.provideService(WorkspaceRef, oldWorkspace))
    const oldEntered = yield* Deferred.make<Execution>()
    const newEntered = yield* Deferred.make<Execution>()
    const oldResume = yield* Deferred.make<void>()
    const newResume = yield* Deferred.make<void>()
    const notify = yield* Deferred.make<boolean>()
    const oldContext = context()
    const newContext = context()
    const original = executions.fork
    let calls = 0
    const fork = spyOn(executions, "fork").mockImplementation((execution, work, scope, onRejected) => {
      const first = calls++ === 0
      return Deferred.succeed(first ? oldEntered : newEntered, execution).pipe(
        Effect.andThen(Deferred.await(first ? oldResume : newResume)),
        Effect.andThen(original(execution, work, scope, onRejected)),
      )
    })
    const send = spyOn(inbox, "send")
    const rejectedWork = spyOn(prompt, "prompt").mockImplementation(() => Effect.die(new Error("fixture stopped new work")))
    let allocate: ReturnType<typeof spyOn<typeof registry, "allocateActorID">> | undefined
    try {
      const spawn = (forkContext: ForkContext) => actors.spawn({
        mode: "subagent", sessionID: session.id, agentType: "custom", task: "fixture", context: "full",
        tools: [], background: true, forkContext, notifyOnCompletion: notify,
      })
      const oldPending = yield* spawn(oldContext).pipe(Effect.provideService(WorkspaceRef, oldWorkspace), Effect.forkChild)
      const old = yield* Deferred.await(oldEntered)
      yield* executions.release(old)
      yield* move(session.id)
      yield* Effect.sync(() => Database.use((db) => db.delete(ActorRegistryTable)
        .where(and(eq(ActorRegistryTable.session_id, session.id), eq(ActorRegistryTable.actor_id, old.actorID))).run()))
      allocate = spyOn(registry, "allocateActorID").mockImplementation(() => Effect.succeed(old.actorID))
      const newPending = yield* spawn(newContext).pipe(Effect.provideService(WorkspaceRef, newWorkspace), Effect.forkChild)
      const replacement = yield* Deferred.await(newEntered)
      expect(yield* actors.getForkContext(session.id, old.actorID)).toBe(newContext)
      yield* Deferred.succeed(oldResume, undefined)
      const oldChild = yield* Fiber.join(oldPending)
      expect((yield* Deferred.await(oldChild.outcome).pipe(Effect.timeout("2 seconds"))).status).toBe("failure")
      expect(yield* actors.getForkContext(session.id, old.actorID)).toBe(newContext)
      expect(executions.currentUnsafe(session.id, old.actorID)).toBe(replacement)
      expect(replacement.cancelled).toBe(false)
      expect(yield* Deferred.isDone(replacement.done)).toBe(false)
      expect(rejectedWork).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
      yield* Deferred.succeed(notify, false)
      yield* Deferred.succeed(newResume, undefined)
      const newChild = yield* Fiber.join(newPending)
      expect((yield* Deferred.await(newChild.outcome).pipe(Effect.timeout("2 seconds"))).status).toBe("failure")
      yield* Deferred.await(replacement.done).pipe(Effect.timeout("2 seconds"))
      expect(rejectedWork).toHaveBeenCalledTimes(1)
      expect(yield* actors.getForkContext(session.id, old.actorID)).toBeUndefined()
      expect(executions.hasActiveUnsafe(session.id)).toBe(false)
      expect(send).not.toHaveBeenCalled()
    } finally {
      Deferred.doneUnsafe(oldResume, Effect.void)
      Deferred.doneUnsafe(newResume, Effect.void)
      Deferred.doneUnsafe(notify, Effect.succeed(false))
      allocate?.mockRestore()
      fork.mockRestore()
      send.mockRestore()
      rejectedWork.mockRestore()
    }
  }), options), 30000)
})
