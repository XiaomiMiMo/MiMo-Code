import { describe, expect, spyOn } from "bun:test"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer, Scheduler } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ActorWaiter, DEFAULT_TIMEOUT_MS, WAIT_TIMEOUT_HINT } from "../../src/actor/waiter"
import { Plugin } from "../../src/plugin"
import { ActorExecution } from "../../src/actor/execution"
import { spawnRef } from "../../src/actor/spawn-ref"
import { inboxServiceRef, sessionPromptRef } from "../../src/inbox/inbox-ref"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { TurnReceiptTable } from "../../src/turn-queue/turn-queue.sql"
import { ActorTool } from "../../src/tool/actor"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { DEFAULT_LIVENESS_STALL_MS } from "../../src/actor/schema"
import { AppLayer } from "../../src/effect/app-runtime"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { TurnQueue, turnQueueRef } from "../../src/turn-queue"
import { Database, NotFoundError, and, eq } from "../../src/storage"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { Bus } from "../../src/bus"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"

const it = testEffect(
  Layer.mergeAll(AppLayer, ActorExecution.layer, CrossSpawnSpawner.defaultLayer, TestLLMServer.layer),
)

const config = (url: string) => ({
  enabled_providers: ["alibaba"],
  provider: { alibaba: { options: { apiKey: "test-key", baseURL: url } } },
  agent: { build: { model: "alibaba/qwen-plus" } },
  checkpoint: { thresholds: [] as string[] },
})

const register = Effect.fn("test.registerChild")(function* (
  sessionID: SessionID,
  actorID: string,
  agent = "general",
  mode: "subagent" | "peer" = "subagent",
  parentActorID = "main",
) {
  const registry = yield* ActorRegistry.Service
  yield* registry.register({
    sessionID,
    actorID,
    mode,
    agent,
    description: "controlled child",
    contextMode: "none",
    background: true,
    lifecycle: "ephemeral",
    parentActorID,
  })
  yield* registry.updateStatus(sessionID, actorID, { status: "running" })
})

const child = Effect.fn("test.child")(function* (
  sessionID: SessionID,
  actorID = "child-1",
  agent = "general",
  mode: "subagent" | "peer" = "subagent",
) {
  yield* register(sessionID, actorID, agent, mode)
  const registry = yield* ActorRegistry.Service
  const executions = yield* ActorExecution.Service
  const execution = yield* Effect.acquireRelease(executions.reserve(sessionID, actorID), executions.release)
  const finish = yield* Deferred.make<void>()
  const terminal = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const fiber = yield* executions.fork(
    execution,
    Effect.gen(function* () {
      yield* Deferred.await(finish)
      yield* registry.updateStatus(sessionID, actorID, { status: "idle", lastOutcome: "success" })
      yield* Deferred.succeed(terminal, undefined)
      yield* Deferred.await(release)
    }).pipe(Effect.interruptible, Effect.ensuring(executions.release(execution))),
    yield* Effect.scope,
  )
  return { execution, fiber, finish, terminal, release }
})

const until = <E, R>(condition: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    while (!(yield* condition)) yield* Effect.sleep("10 millis")
  }).pipe(Effect.timeout("5 seconds"))

const trackTerminalNotifications = (sessionID: SessionID) => Effect.gen(function* () {
  const inbox = inboxServiceRef.current
  if (!inbox) throw new Error("fixture did not initialize Inbox")
  const delivered: string[] = []
  yield* Effect.acquireRelease(Effect.sync(() => {
    const previous = inbox.send
    Object.assign(inbox, { send: (input: Parameters<typeof previous>[0]) => Effect.gen(function* () {
      const result = yield* previous(input)
      if (input.receiverSessionID === sessionID && input.receiverActorID === "main"
        && input.senderActorID === "general-1" && input.type === "actor_notification") delivered.push(input.content)
      return result
    }) })
    return previous
  }), (previous) => Effect.sync(() => { Object.assign(inbox, { send: previous }) }))
  return delivered
})

const terminalNotifications = (sessionID: SessionID, actorID = "general-1") => Effect.sync(() =>
  Database.use((db) => db.select().from(InboxTable).where(and(
    eq(InboxTable.receiver_session_id, sessionID),
    eq(InboxTable.receiver_actor_id, "main"),
    eq(InboxTable.sender_actor_id, actorID),
    eq(InboxTable.type, "actor_notification"),
  )).all()),
)

const waiting = (sessionID: SessionID) =>
  SessionStatus.Service.use((status) =>
    until(
      status
        .get(sessionID)
        .pipe(Effect.map((value) => value.type === "busy" && !!value.message?.startsWith("Waiting for"))),
    ),
  )

const busy = Effect.fn("test.mainBusy")(function* (sessionID: SessionID) {
  const state = yield* SessionRunState.Service
  const status = yield* SessionStatus.Service
  expect(Exit.isFailure(yield* state.assertNotBusy(sessionID, "main").pipe(Effect.exit))).toBe(true)
  expect((yield* status.get(sessionID)).type).toBe("busy")
})

const start = Effect.fn("test.startMain")(function* (sessionID: SessionID) {
  const prompt = yield* SessionPrompt.Service
  yield* Effect.addFinalizer(() => prompt.cancel(sessionID))
  return yield* prompt
    .prompt({ sessionID, agent: "build", parts: [{ type: "text", text: "Finish the main task." }] })
    .pipe(Effect.forkChild)
})

const complete = Effect.fn("test.completeChild")(function* (held: Effect.Success<ReturnType<typeof child>>) {
  yield* Deferred.succeed(held.finish, undefined)
  yield* Deferred.succeed(held.release, undefined)
  yield* Fiber.join(held.fiber)
})

describe("main automatically waits for subagent executions", () => {
  it.live(
    "a legacy Runner interrupted before work starts is reported dead despite its stale busy ledger",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const state = yield* SessionRunState.Service
      const executions = yield* ActorExecution.Service
      const registry = yield* ActorRegistry.Service
      const session = yield* sessions.create({ title: "stale legacy runner" })
      yield* register(session.id, "legacy-1")
      let started = false
      const fiber = yield* Effect.gen(function* () {
        yield* state.start(session.id, "legacy-1", Effect.never,
          Effect.sync(() => { started = true }).pipe(Effect.andThen(Effect.never)))
        const snapshot = yield* state.executionSnapshot(session.id, "legacy-1")
        if (!snapshot.fiber) throw new Error("legacy runner did not start")
        snapshot.fiber.interruptUnsafe()
        return snapshot.fiber
      }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true))
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(started).toBe(false)
      expect(Exit.isFailure(yield* state.assertNotBusy(session.id, "legacy-1").pipe(Effect.exit))).toBe(true)
      expect(yield* executions.current(session.id, "legacy-1")).toBeUndefined()
      yield* llm.text("FIRST-FINAL")
      yield* llm.text("ACKNOWLEDGED-LEGACY-FAILURE")
      const main = yield* start(session.id)
      const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
      expect((yield* registry.get(session.id, "legacy-1"))?.lastOutcome).toBe("failure")
      expect(JSON.stringify((yield* llm.inputs)[1]?.messages)).toContain("legacy-1")
      expect(result.parts.some((part) => part.type === "text" && part.text === "ACKNOWLEDGED-LEGACY-FAILURE")).toBe(true)
      expect(yield* llm.calls).toBe(2)
    }), { git: true, config }),
    20000,
  )

  it.live(
    "a live legacy Runner without ActorExecution keeps main waiting until its fiber exits",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const state = yield* SessionRunState.Service
      const executions = yield* ActorExecution.Service
      const registry = yield* ActorRegistry.Service
      const session = yield* sessions.create({ title: "live legacy runner" })
      yield* register(session.id, "legacy-1")
      const finish = yield* Deferred.make<void>()
      yield* state.start(session.id, "legacy-1", Effect.never, Effect.gen(function* () {
        yield* Deferred.await(finish)
        yield* registry.updateStatus(session.id, "legacy-1", { status: "idle", lastOutcome: "success" })
        return (yield* sessions.messages({ sessionID: session.id })).at(-1)!
      }))
      expect(yield* executions.current(session.id, "legacy-1")).toBeUndefined()
      yield* llm.text("MAIN-FINAL")
      const main = yield* start(session.id)
      yield* waiting(session.id)
      yield* busy(session.id)
      const snapshot = yield* state.executionSnapshot(session.id, "legacy-1")
      expect(snapshot.fiber).toBeDefined()
      expect(snapshot.fiber?.pollUnsafe()).toBeUndefined()
      expect(main.pollUnsafe()).toBeUndefined()
      expect((yield* registry.get(session.id, "legacy-1"))?.lastOutcome).toBeUndefined()
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
      expect((yield* registry.get(session.id, "legacy-1"))?.lastOutcome).toBe("success")
      expect(yield* llm.calls).toBe(1)
    }), { git: true, config }),
    20000,
  )

  it.live(
    "natural final keeps the main Runner busy through child terminal status until execution release",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const state = yield* SessionRunState.Service
          const executions = yield* ActorExecution.Service
          const session = yield* sessions.create({ title: "main waits for release" })
          const held = yield* child(session.id)
          const bus = yield* Bus.Service
          const idleBeforeRelease: boolean[] = []
          const unsubscribe = yield* bus.subscribeCallback(SessionStatus.Event.Status, (event) => {
            if (event.properties.sessionID === session.id && event.properties.status.type === "idle")
              idleBeforeRelease.push(held.fiber.pollUnsafe() === undefined)
          })
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
          yield* llm.text("MAIN-FINAL")
          const main = yield* start(session.id)
          yield* waiting(session.id)
          yield* busy(session.id)
          expect(main.pollUnsafe()).toBeUndefined()
          expect(yield* llm.calls).toBe(1)
          const messages = yield* sessions.messages({ sessionID: session.id })
          expect(
            messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "MAIN-FINAL"),
            ),
          ).toBe(true)

          yield* Deferred.succeed(held.finish, undefined)
          yield* Deferred.await(held.terminal)
          yield* Effect.sleep("50 millis")
          yield* busy(session.id)
          expect(main.pollUnsafe()).toBeUndefined()
          expect(yield* executions.current(session.id, "child-1")).toBe(held.execution)
          expect(yield* Deferred.isDone(held.execution.done)).toBe(false)
          expect(idleBeforeRelease).toEqual([])

          yield* Deferred.succeed(held.release, undefined)
          yield* Fiber.join(held.fiber)
          const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          expect(result.parts.some((part) => part.type === "text" && part.text === "MAIN-FINAL")).toBe(true)
          yield* state.assertNotBusy(session.id, "main")
          yield* until(Effect.sync(() => idleBeforeRelease.length > 0))
          expect(idleBeforeRelease).toEqual([false])
          expect(yield* executions.current(session.id, "child-1")).toBeUndefined()
          expect(yield* llm.calls).toBe(1)
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "child success released after the running registry snapshot is not overwritten as orphan failure",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const registry = yield* ActorRegistry.Service
          const executions = yield* ActorExecution.Service
          const session = yield* sessions.create({ title: "terminal snapshot race" })
          const held = yield* child(session.id)
          const intercepted = yield* Deferred.make<void>()
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = registry.listBySession
              Object.assign(registry, {
                listBySession: (sessionID: SessionID) =>
                  Effect.gen(function* () {
                    const snapshot = yield* previous(sessionID)
                    if (sessionID !== session.id || (yield* Deferred.isDone(intercepted))) return snapshot
                    const messages = yield* sessions.messages({ sessionID })
                    if (
                      !messages.some((message) => message.info.role === "assistant" && message.info.finish === "stop")
                    )
                      return snapshot
                    expect(snapshot.find((actor) => actor.actorID === "child-1")?.status).toBe("running")
                    yield* complete(held)
                    yield* Deferred.succeed(intercepted, undefined)
                    return snapshot
                  }),
              })
              return previous
            }),
            (previous) =>
              Effect.sync(() => {
                Object.assign(registry, { listBySession: previous })
              }),
          )
          yield* llm.text("MAIN-FINAL")
          const main = yield* start(session.id)
          const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          expect(yield* Deferred.isDone(intercepted)).toBe(true)
          expect((yield* registry.get(session.id, "child-1"))?.lastOutcome).toBe("success")
          expect((yield* registry.get(session.id, "child-1"))?.lastError).toBeUndefined()
          expect(yield* executions.current(session.id, "child-1")).toBeUndefined()
          expect(result.parts.some((part) => part.type === "text" && part.text === "MAIN-FINAL")).toBe(true)
          expect(yield* llm.calls).toBe(1)
          const history = JSON.stringify(yield* sessions.messages({ sessionID: session.id }))
          expect(history).not.toContain("no active execution remains")
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "wake-only claim extension cannot roll the current user frontier back to a previously consumed user",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const tq = yield* TurnQueue.Service
          const session = yield* sessions.create({ title: "monotonic claimed frontier" })
          yield* llm.text("U0-ANSWER")
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "Previously consumed U0." }],
          })
          expect(yield* llm.calls).toBe(1)
          const held = yield* child(session.id)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let first = true
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = turnQueueRef.current
              turnQueueRef.current = {
                ...tq,
                extendClaim: (lane, runId) =>
                  Effect.gen(function* () {
                    if (lane.sessionID === session.id && first) {
                      first = false
                      yield* Deferred.succeed(entered, undefined)
                      yield* Deferred.await(release)
                    }
                    return yield* tq.extendClaim(lane, runId)
                  }),
              }
              return previous
            }),
            (previous) =>
              Effect.sync(() => {
                turnQueueRef.current = previous
              }),
          )
          yield* llm.text("U1-ANSWER")
          yield* Effect.addFinalizer(() => prompt.cancel(session.id))
          const main = yield* prompt
            .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "Current claimed U1." }] })
            .pipe(Effect.forkChild)
          yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
          const wake = yield* tq.admit({
            lane: { sessionID: session.id, agentID: "main" },
            intent: { kind: "wake", receiverActorID: "main", inboxWatermark: "test-wake" },
          })
          yield* Deferred.succeed(release, undefined)
          yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
          yield* waiting(session.id)
          yield* busy(session.id)
          expect(JSON.stringify((yield* llm.inputs)[1]?.messages)).toContain("Current claimed U1.")
          expect((yield* tq.getReceipt(wake.id)).state).toBe("claimed")
          yield* complete(held)
          const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          expect(result.parts.some((part) => part.type === "text" && part.text === "U1-ANSWER")).toBe(true)
          expect((yield* tq.getReceipt(wake.id)).outcome).toBe("success")
          expect(yield* llm.calls).toBe(2)
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "a user persisted before assistant creation but admitted during its LLM call needs a new model answer",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const tq = yield* TurnQueue.Service
          const session = yield* sessions.create({ title: "late admission before assistant id" })
          const held = yield* child(session.id)
          const entered = yield* Deferred.make<void>()
          const snapshot = yield* Deferred.make<void>()
          const response = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => response.resolve()))
          let first = true
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = turnQueueRef.current
              turnQueueRef.current = {
                ...tq,
                extendClaim: (lane, runId) =>
                  Effect.gen(function* () {
                    if (lane.sessionID === session.id && first) {
                      first = false
                      yield* Deferred.succeed(entered, undefined)
                      yield* Deferred.await(snapshot)
                    }
                    return yield* tq.extendClaim(lane, runId)
                  }),
              }
              return previous
            }),
            (previous) =>
              Effect.sync(() => {
                turnQueueRef.current = previous
              }),
          )
          yield* llm.hold("ANSWER-ONLY-ORIGINAL", response.promise)
          yield* llm.text("ANSWER-LATE-ADMISSION")
          const main = yield* start(session.id)
          yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
          const original = (yield* sessions.messages({ sessionID: session.id })).find(
            (message) => message.info.role === "user",
          )
          if (!original || original.info.role !== "user") throw new Error("initial user missing")
          const messageID = MessageID.ascending()
          yield* sessions.updateMessage({ ...original.info, id: messageID, time: { created: Date.now() } })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID,
            type: "text",
            text: "U2 must receive its own answer.",
          })
          yield* Deferred.succeed(snapshot, undefined)
          yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
          expect(JSON.stringify((yield* llm.inputs)[0]?.messages)).not.toContain("U2 must receive its own answer.")
          const assistant = (yield* sessions.messages({ sessionID: session.id })).find(
            (message) => message.info.role === "assistant",
          )
          if (!assistant || assistant.info.role !== "assistant") throw new Error("initial assistant missing")
          expect(messageID < assistant.info.id).toBe(true)
          expect(assistant.info.parentID).toBe(original.info.id)
          const receipt = yield* tq.admit({
            lane: { sessionID: session.id, agentID: "main" },
            intent: { kind: "prompt", messageID },
          })
          response.resolve()
          yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
          yield* waiting(session.id)
          expect(JSON.stringify((yield* llm.inputs)[1]?.messages)).toContain("U2 must receive its own answer.")
          expect((yield* tq.getReceipt(receipt.id)).state).toBe("claimed")
          yield* busy(session.id)
          yield* complete(held)
          const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          expect(result.info.role).toBe("assistant")
          if (result.info.role === "assistant") expect(result.info.parentID).toBe(messageID)
          expect(result.parts.some((part) => part.type === "text" && part.text === "ANSWER-LATE-ADMISSION")).toBe(true)
          expect((yield* tq.getReceipt(receipt.id)).outcome).toBe("success")
          expect(yield* llm.calls).toBe(2)
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "a nested orphan reports failure to main even when its immediate parent is idle",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const registry = yield* ActorRegistry.Service
          const session = yield* sessions.create({ title: "nested orphan delivery" })
          yield* register(session.id, "parent-1")
          yield* registry.updateStatus(session.id, "parent-1", { status: "idle", lastOutcome: "success" })
          yield* register(session.id, "nested-1", "general", "subagent", "parent-1")
          yield* llm.text("MAIN-FINAL")
          yield* llm.text("MAIN-ACKNOWLEDGED-NESTED-FAILURE")
          const main = yield* start(session.id)
          const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          expect((yield* registry.get(session.id, "nested-1"))?.lastOutcome).toBe("failure")
          expect((yield* registry.get(session.id, "parent-1"))?.lastOutcome).toBe("success")
          expect(yield* llm.calls).toBe(2)
          const followup = JSON.stringify((yield* llm.inputs)[1]?.messages)
          expect(followup).toContain("actor-notification")
          expect(followup).toContain("nested-1")
          expect(followup).toContain("failed")
          expect(
            result.parts.some((part) => part.type === "text" && part.text === "MAIN-ACKNOWLEDGED-NESTED-FAILURE"),
          ).toBe(true)
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "steer during final wait consumes new input in a third LLM step without cancelling the child",
    provideTmpdirServer(
      ({ llm, dir }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const executions = yield* ActorExecution.Service
          const registry = yield* ActorRegistry.Service
          const session = yield* sessions.create({
            title: "steer while waiting",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const held = yield* child(session.id)
          yield* llm.tool("read", { file_path: dir })
          yield* llm.text("INITIAL-FINAL")
          yield* llm.text("STEERED-FINAL")
          const main = yield* start(session.id)
          yield* waiting(session.id)
          expect(yield* llm.calls).toBe(2)
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "Include the new constraint." }],
          })
          yield* llm.wait(3).pipe(Effect.timeout("5 seconds"))
          yield* waiting(session.id)
          yield* busy(session.id)
          expect(main.pollUnsafe()).toBeUndefined()
          expect(held.fiber.pollUnsafe()).toBeUndefined()
          expect(held.execution.cancelled).toBe(false)
          expect(yield* Deferred.isDone(held.execution.done)).toBe(false)
          expect(yield* executions.current(session.id, "child-1")).toBe(held.execution)
          expect((yield* registry.get(session.id, "child-1"))?.status).toBe("running")
          expect(JSON.stringify((yield* llm.inputs)[2]?.messages)).toContain("Include the new constraint.")
          yield* complete(held)
          const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          expect(result.parts.some((part) => part.type === "text" && part.text === "STEERED-FINAL")).toBe(true)
          expect(yield* llm.calls).toBe(3)
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "a persisted user beyond the claim frontier cannot bypass child waiting before admission",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const tq = yield* TurnQueue.Service
          const session = yield* sessions.create({ title: "persistence before admission" })
          const held = yield* child(session.id)
          const release = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
          yield* llm.hold("FIRST-FINAL", release.promise)
          yield* llm.text("ADMITTED-FINAL")
          const main = yield* start(session.id)
          yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
          const original = (yield* sessions.messages({ sessionID: session.id })).find(
            (message) => message.info.role === "user",
          )
          if (!original || original.info.role !== "user") throw new Error("initial user missing")
          const messageID = MessageID.ascending()
          yield* sessions.updateMessage({ ...original.info, id: messageID, time: { created: Date.now() } })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID,
            type: "text",
            text: "Persisted before admission.",
          })
          release.resolve()
          yield* waiting(session.id)
          yield* busy(session.id)
          expect(main.pollUnsafe()).toBeUndefined()
          expect(yield* llm.calls).toBe(1)
          const receipt = yield* tq.admit({
            lane: { sessionID: session.id, agentID: "main" },
            intent: { kind: "prompt", messageID },
          })
          yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
          yield* waiting(session.id)
          expect(JSON.stringify((yield* llm.inputs)[1]?.messages)).toContain("Persisted before admission.")
          expect((yield* tq.getReceipt(receipt.id))?.state).toBe("claimed")
          yield* busy(session.id)
          yield* complete(held)
          const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          expect(result.parts.some((part) => part.type === "text" && part.text === "ADMITTED-FINAL")).toBe(true)
          expect((yield* tq.getReceipt(receipt.id))?.outcome).toBe("success")
          expect(yield* llm.calls).toBe(2)
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "input admitted at claim extension enters the immediately following model snapshot",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const tq = yield* TurnQueue.Service
          const session = yield* sessions.create({ title: "claim before snapshot" })
          const held = yield* child(session.id)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let first = true
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = turnQueueRef.current
              turnQueueRef.current = {
                ...tq,
                extendClaim: (lane, runId) =>
                  Effect.gen(function* () {
                    if (lane.sessionID === session.id && first) {
                      first = false
                      yield* Deferred.succeed(entered, undefined)
                      yield* Deferred.await(release)
                    }
                    return yield* tq.extendClaim(lane, runId)
                  }),
              }
              return previous
            }),
            (previous) =>
              Effect.sync(() => {
                turnQueueRef.current = previous
              }),
          )
          yield* llm.text("BOTH-INPUTS-ANSWERED")
          const main = yield* start(session.id)
          yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "Admitted during claim expansion." }],
          })
          yield* Deferred.succeed(release, undefined)
          yield* waiting(session.id)
          yield* busy(session.id)
          expect(JSON.stringify((yield* llm.inputs)[0]?.messages)).toContain("Admitted during claim expansion.")
          expect(yield* llm.calls).toBe(1)
          yield* complete(held)
          yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          expect(yield* llm.calls).toBe(1)
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "a real actor spawn tool leaves main busy until the child model response and terminal notification arrive",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const registry = yield* ActorRegistry.Service
          const executions = yield* ActorExecution.Service
          const session = yield* sessions.create({
            title: "real background spawn",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const release = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
          yield* llm.pushMatch((hit) => {
            if (!Array.isArray(hit.body.messages)) return false
            const last = hit.body.messages.at(-1)
            return last?.role === "user" && JSON.stringify(last.content).includes("CHILD-WORK")
          }, reply().wait(release.promise).text("CHILD-RESULT").stop())
          yield* llm.tool("actor", {
            operation: {
              action: "spawn",
              subagent_type: "general",
              description: "controlled background work",
              prompt: "CHILD-WORK",
            },
          })
          yield* llm.text("MAIN-FINAL-BEFORE-CHILD")
          yield* llm.text("MAIN-ACKNOWLEDGED-CHILD")
          const owners = {
            actor: spawnRef.current,
            prompt: sessionPromptRef.current,
            queue: turnQueueRef.current,
          }
          expect(owners.actor).toBeDefined()
          expect(owners.prompt).toBeDefined()
          expect(owners.queue).toBeDefined()
          const main = yield* start(session.id)
          yield* waiting(session.id)
          yield* busy(session.id)
          expect(spawnRef.current).toBe(owners.actor)
          expect(sessionPromptRef.current).toBe(owners.prompt)
          expect(turnQueueRef.current).toBe(owners.queue)
          expect(yield* llm.calls).toBe(3)
          const actor = (yield* registry.listBySession(session.id)).find((actor) => actor.agent === "general")
          expect(actor?.status).toBe("running")
          if (!actor) throw new Error("spawn did not register a child")
          const execution = yield* executions.current(session.id, actor.actorID)
          expect(execution?.fiber?.pollUnsafe()).toBeUndefined()
          expect(execution).toBeDefined()
          const before = yield* sessions.messages({ sessionID: session.id })
          expect(
            before.some((message) =>
              message.parts.some(
                (part) => part.type === "tool" && part.tool === "actor" && part.state.status === "completed",
              ),
            ),
          ).toBe(true)
          release.resolve()
          const result = yield* Fiber.join(main).pipe(Effect.timeout("10 seconds"))
          expect(result.parts.some((part) => part.type === "text" && part.text === "MAIN-ACKNOWLEDGED-CHILD")).toBe(
            true,
          )
          expect((yield* registry.get(session.id, actor.actorID))?.lastOutcome).toBe("success")
          expect(yield* executions.current(session.id, actor.actorID)).toBeUndefined()
          expect(JSON.stringify((yield* llm.inputs)[3]?.messages)).toContain("CHILD-RESULT")
          expect(yield* llm.calls).toBe(4)
        }),
      {
        git: true,
        config: (url) => ({
          ...config(url),
          agent: { ...config(url).agent, general: { model: "alibaba/qwen-plus", completionGate: false } },
        }),
      },
    ),
    25000,
  )

  it.live(
    "natural final remains non-resumable through postStop and notification handoff without duplicate execution",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const runs = yield* SessionRunState.Service
      const registry = yield* ActorRegistry.Service
      const executions = yield* ActorExecution.Service
      const waiter = yield* ActorWaiter.Service
      const plugin = yield* Plugin.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({
        title: "resume during child finalization", permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const childReply = Promise.withResolvers<void>()
      const waitingForChild = Promise.withResolvers<void>()
      const postStopEntered = yield* Deferred.make<void>()
      const postStopRelease = yield* Deferred.make<void>()
      const notifyEntered = yield* Deferred.make<void>()
      const notifyRelease = yield* Deferred.make<void>()
      const delivered = yield* trackTerminalNotifications(session.id)
      yield* Effect.acquireRelease(
        bus.subscribeCallback(SessionStatus.Event.Status, (event) => {
          if (event.properties.sessionID === session.id && event.properties.status.type === "busy"
            && event.properties.status.message?.startsWith("Waiting for")) waitingForChild.resolve()
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
      yield* Effect.acquireRelease(Effect.sync(() => {
        const previous = plugin.triggerActorPostStop
        Object.assign(plugin, { triggerActorPostStop: (input: Parameters<typeof previous>[0]) => Effect.gen(function* () {
          if (input.sessionID === session.id && input.actorID === "general-1") {
            yield* Deferred.succeed(postStopEntered, undefined)
            yield* Deferred.await(postStopRelease)
          }
          return yield* previous(input)
        }) })
        return previous
      }), (previous) => Effect.sync(() => { Object.assign(plugin, { triggerActorPostStop: previous }) }))
      const inbox = inboxServiceRef.current
      if (!inbox) throw new Error("fixture did not initialize Inbox")
      yield* Effect.acquireRelease(Effect.sync(() => {
        const previous = inbox.send
        Object.assign(inbox, { send: (input: Parameters<typeof previous>[0]) => Effect.gen(function* () {
          if (input.receiverSessionID === session.id && input.senderActorID === "general-1" && input.type === "actor_notification") {
            yield* Deferred.succeed(notifyEntered, undefined)
            yield* Deferred.await(notifyRelease)
          }
          return yield* previous(input)
        }) })
        return previous
      }), (previous) => Effect.sync(() => { Object.assign(inbox, { send: previous }) }))
      yield* llm.pushMatch((hit) => {
        if (!Array.isArray(hit.body.messages)) return false
        const last = hit.body.messages.at(-1)
        return last?.role === "user" && JSON.stringify(last.content).includes("FINALIZATION-CHILD")
      }, reply().wait(childReply.promise).text("FINALIZATION-RESULT").stop())
      yield* llm.tool("actor", { operation: {
        action: "spawn", subagent_type: "general", description: "finalization child", prompt: "FINALIZATION-CHILD",
      } })
      yield* llm.text("MAIN-NATURAL-FINAL")
      yield* llm.text("MAIN-NOTIFICATION-ACK")
      const main = yield* start(session.id)
      yield* Effect.addFinalizer(() => Effect.gen(function* () {
        childReply.resolve()
        yield* Deferred.succeed(postStopRelease, undefined)
        yield* Deferred.succeed(notifyRelease, undefined)
      }))
      yield* Effect.promise(() => waitingForChild.promise)
      const owned = yield* runs.executionSnapshot(session.id, "main")
      if (!owned.fiber) throw new Error("main Runner missing while waiting")
      const execution = yield* executions.current(session.id, "general-1")
      if (!execution?.fiber) throw new Error("child execution missing while waiting")
      const sample = Effect.gen(function* () {
        yield* busy(session.id)
        expect((yield* runs.executionSnapshot(session.id, "main")).fiber).toBe(owned.fiber)
        expect(owned.fiber?.pollUnsafe()).toBeUndefined()
        expect(execution.fiber?.pollUnsafe()).toBeUndefined()
        expect(execution.cancelled).toBe(false)
        const actor = yield* registry.get(session.id, "general-1")
        if (!actor) throw new Error("child actor missing")
        expect(yield* waiter.status(actor)).toMatchObject({ status: "running", executionActive: true })
        expect(yield* prompt.recovery({ sessionID: session.id })).toEqual([])
        const resumed = yield* prompt.resumeBackground({ sessionID: session.id }).pipe(Effect.exit)
        expect(Exit.isFailure(resumed)).toBe(true)
        if (Exit.isFailure(resumed)) expect(Cause.squash(resumed.cause)).toBeInstanceOf(NotFoundError)
        expect(yield* llm.calls).toBe(3)
        expect(delivered).toHaveLength(0)
      })
      yield* sample
      childReply.resolve()
      yield* Deferred.await(postStopEntered)
      yield* sample
      yield* sample
      yield* Deferred.succeed(postStopRelease, undefined)
      yield* Deferred.await(notifyEntered)
      expect((yield* registry.get(session.id, "general-1"))?.status).toBe("idle")
      yield* sample
      yield* Deferred.succeed(notifyRelease, undefined)
      const result = yield* Fiber.join(main)
      expect(result.parts.some((part) => part.type === "text" && part.text === "MAIN-NOTIFICATION-ACK")).toBe(true)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toContain("FINALIZATION-RESULT")
      expect(yield* llm.calls).toBe(4)
      expect(yield* executions.current(session.id, "general-1")).toBeUndefined()
      expect(execution.cancelled).toBe(false)
    }), {
      git: true,
      config: (url) => ({ ...config(url), agent: { ...config(url).agent, general: { model: "alibaba/qwen-plus", completionGate: false } } }),
    }),
    20000,
  )

  for (const formatChange of ["preserve", "replace", "clear"] as const) it.live(
    formatChange === "preserve"
      ? "structured automatic wait preserves its schema after a partial child completion notification"
      : `structured automatic wait honors user format ${formatChange} arriving with a child notification`,
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const inbox = inboxServiceRef.current
      if (!inbox) throw new Error("main fixture did not initialize Inbox")
      const executions = yield* ActorExecution.Service
      const session = yield* sessions.create({ title: "structured partial child notification" })
      const finished = yield* child(session.id, "child-1")
      const pending = yield* child(session.id, "child-2")
      const response = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => response.resolve()))
      const replacementSchema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }
      const finalStructured = formatChange === "replace" ? { summary: "AFTER-NOTIFICATION" } : { answer: "AFTER-NOTIFICATION" }
      yield* llm.tool("StructuredOutput", { answer: "BEFORE-NOTIFICATION" })
      if (formatChange === "clear") yield* llm.hold("PLAIN-AFTER-NOTIFICATION", response.promise)
      else yield* llm.push(reply().wait(response.promise).tool("StructuredOutput", finalStructured))
      yield* Effect.addFinalizer(() => prompt.cancel(session.id))
      const main = yield* prompt.prompt({
        sessionID: session.id, agent: "build", parts: [{ type: "text", text: "Return the answer in the schema." }],
        format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, retryCount: 0 },
      }).pipe(Effect.forkChild)
      yield* waiting(session.id)
      expect(yield* llm.calls).toBe(1)
      yield* inbox.send({
        receiverSessionID: session.id, receiverActorID: "main", senderSessionID: session.id, senderActorID: "child-1",
        type: "actor_notification", wake: false,
        content: '<actor-notification actor_id="child-1" status="completed">PARTIAL-CHILD-RESULT</actor-notification>',
      })
      if (formatChange !== "preserve") yield* prompt.prompt({
        sessionID: session.id, agent: "build", noReply: true,
        parts: [{ type: "text", text: `USER-FORMAT-${formatChange}: use my new response format.` }],
        format: formatChange === "replace" ? { type: "json_schema", schema: replacementSchema, retryCount: 0 } : undefined,
      })
      yield* complete(finished)
      yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
      const inputs = yield* llm.inputs
      const structuredTool = (input: Record<string, unknown>) =>
        (input.tools as { type: string; function: { name: string; parameters: unknown } }[])
          .find((tool) => tool.function.name === "StructuredOutput")
      expect(structuredTool(inputs[0]!)).toBeDefined()
      if (formatChange === "preserve") expect(structuredTool(inputs[1]!)).toEqual(structuredTool(inputs[0]!))
      else {
        expect(JSON.stringify(inputs[1]!.messages)).toContain(`USER-FORMAT-${formatChange}`)
        const lastUser = (yield* sessions.messages({ sessionID: session.id })).findLast((message) => message.info.role === "user")
        expect(lastUser?.parts.every((part) => part.type === "text" && part.synthetic)).toBe(true)
        if (formatChange === "replace") expect(structuredTool(inputs[1]!)?.function.parameters).toEqual(replacementSchema)
        else expect(structuredTool(inputs[1]!)).toBeUndefined()
      }
      expect(JSON.stringify(inputs[1]!.messages)).toContain("PARTIAL-CHILD-RESULT")
      expect(yield* executions.current(session.id, "child-2")).toBe(pending.execution)
      expect(pending.fiber.pollUnsafe()).toBeUndefined()
      expect(pending.execution.cancelled).toBe(false)
      expect(yield* Deferred.isDone(pending.execution.done)).toBe(false)
      yield* complete(pending)
      response.resolve()
      const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.error).toBeUndefined()
        expect(result.info.structured).toEqual(formatChange === "clear" ? undefined : finalStructured)
        if (formatChange === "clear") expect(result.parts.some((part) => part.type === "text" && part.text === "PLAIN-AFTER-NOTIFICATION")).toBe(true)
      }
      expect(yield* llm.calls).toBe(2)
    }), { git: true, config }),
    20000,
  )

  for (const formatChange of ["replace", "clear"] as const) it.live(
    `late-admitted user format ${formatChange} supersedes a newer child notification on the third model step`,
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const tq = yield* TurnQueue.Service
      const inbox = inboxServiceRef.current
      if (!inbox) throw new Error("main fixture did not initialize Inbox")
      const session = yield* sessions.create({ title: `late-admitted format ${formatChange}` })
      const finished = yield* child(session.id, "child-1")
      const pending = yield* child(session.id, "child-2")
      const second = Promise.withResolvers<void>()
      const third = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => { second.resolve(); third.resolve() }))
      const replacementSchema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }
      yield* llm.tool("StructuredOutput", { answer: "ORIGINAL-A" })
      yield* llm.push(reply().wait(second.promise).tool("StructuredOutput", { answer: "NOTIFICATION-A" }))
      if (formatChange === "replace") yield* llm.push(reply().wait(third.promise).tool("StructuredOutput", { summary: "ADMITTED-B" }))
      else yield* llm.hold("ADMITTED-PLAIN-TEXT", third.promise)
      yield* Effect.addFinalizer(() => prompt.cancel(session.id))
      const main = yield* prompt.prompt({
        sessionID: session.id, agent: "build", parts: [{ type: "text", text: "Original request with schema A." }],
        format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, retryCount: 0 },
      }).pipe(Effect.forkChild)
      yield* waiting(session.id)
      const original = (yield* sessions.messages({ sessionID: session.id })).find((message) => message.info.role === "user")
      if (!original || original.info.role !== "user") throw new Error("original schema A user missing")
      const messageID = MessageID.ascending()
      yield* sessions.updateMessage({
        ...original.info, id: messageID, time: { created: Date.now() },
        format: formatChange === "replace" ? { type: "json_schema", schema: replacementSchema, retryCount: 0 } : undefined,
      })
      yield* sessions.updatePart({
        id: PartID.ascending(), sessionID: session.id, messageID, type: "text",
        text: `LATE-USER-FORMAT-${formatChange}`,
      })
      yield* inbox.send({
        receiverSessionID: session.id, receiverActorID: "main", senderSessionID: session.id, senderActorID: "child-1",
        type: "actor_notification", wake: false,
        content: '<actor-notification actor_id="child-1" status="completed">LATE-ADMISSION-NOTIFICATION</actor-notification>',
      })
      yield* complete(finished)
      yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
      const structuredTool = (input: Record<string, unknown>) =>
        (input.tools as { type: string; function: { name: string; parameters: unknown } }[])
          .find((tool) => tool.function.name === "StructuredOutput")
      const beforeAdmission = yield* llm.inputs
      expect(structuredTool(beforeAdmission[0]!)).toBeDefined()
      expect(structuredTool(beforeAdmission[1]!)).toEqual(structuredTool(beforeAdmission[0]!))
      expect(JSON.stringify(beforeAdmission[1]!.messages)).toContain("LATE-ADMISSION-NOTIFICATION")
      expect(JSON.stringify(beforeAdmission[1]!.messages)).not.toContain(`LATE-USER-FORMAT-${formatChange}`)
      const notification = (yield* sessions.messages({ sessionID: session.id })).find((message) =>
        message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.synthetic
          && part.text.includes("LATE-ADMISSION-NOTIFICATION")))
      if (!notification) throw new Error("notification synthetic user missing")
      expect(messageID < notification.info.id).toBe(true)
      const receipt = yield* tq.admit({
        lane: { sessionID: session.id, agentID: "main" }, intent: { kind: "prompt", messageID },
      })
      second.resolve()
      yield* llm.wait(3).pipe(Effect.timeout("5 seconds"))
      const admitted = (yield* llm.inputs)[2]!
      expect(JSON.stringify(admitted.messages)).toContain(`LATE-USER-FORMAT-${formatChange}`)
      if (formatChange === "replace") expect(structuredTool(admitted)?.function.parameters).toEqual(replacementSchema)
      else expect(structuredTool(admitted)).toBeUndefined()
      expect(pending.fiber.pollUnsafe()).toBeUndefined()
      expect(pending.execution.cancelled).toBe(false)
      expect(yield* Deferred.isDone(pending.execution.done)).toBe(false)
      yield* complete(pending)
      third.resolve()
      const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.error).toBeUndefined()
        expect(result.info.structured).toEqual(formatChange === "replace" ? { summary: "ADMITTED-B" } : undefined)
      }
      if (formatChange === "clear") expect(result.parts.some((part) => part.type === "text" && part.text === "ADMITTED-PLAIN-TEXT")).toBe(true)
      expect((yield* tq.getReceipt(receipt.id)).outcome).toBe("success")
      expect(yield* llm.calls).toBe(3)
    }), { git: true, config }),
    20000,
  )

  for (const structured of [false, true]) it.live(
    `automatic wait returns its fixed ten-minute deadline hint to main while the child remains active (${structured ? "structured" : "text"})`,
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const liveClock = yield* Clock.Clock
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const executions = yield* ActorExecution.Service
        const registry = yield* ActorRegistry.Service
        const session = yield* sessions.create({ title: "automatic wait deadline" })
        expect(DEFAULT_TIMEOUT_MS).toBe(600_000)
        const bus = yield* Bus.Service
        let refreshes = 0
        const unsubscribe = yield* bus.subscribeCallback(SessionStatus.Event.Status, (event) => {
          if (event.properties.sessionID === session.id && event.properties.status.type === "busy"
            && event.properties.status.message?.startsWith("Waiting for")) refreshes++
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
        const held = yield* child(session.id)
        if (structured) yield* llm.tool("StructuredOutput", { answer: "FIRST-FINAL" })
        else yield* llm.text("FIRST-FINAL")
        const response = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => response.resolve()))
        if (structured) yield* llm.push(reply().wait(response.promise).tool("StructuredOutput", { answer: "MAIN-INSPECTED-TIMEOUT" }))
        else yield* llm.hold("MAIN-INSPECTED-TIMEOUT", response.promise)
        const prompt = yield* SessionPrompt.Service
        yield* Effect.addFinalizer(() => prompt.cancel(session.id))
        const main = structured ? yield* prompt.prompt({
          sessionID: session.id, agent: "build", parts: [{ type: "text", text: "Return the answer in the schema." }],
          format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, retryCount: 0 },
        }).pipe(Effect.forkChild) : yield* start(session.id)
        yield* waiting(session.id).pipe(Effect.provideService(Clock.Clock, liveClock))
        const started = Date.now()
        const clock = yield* Effect.acquireRelease(
          Effect.sync(() => spyOn(Date, "now").mockReturnValue(started + DEFAULT_TIMEOUT_MS / 2)),
          (spy) => Effect.sync(() => spy.mockRestore()),
        )
        yield* TestClock.adjust("30 seconds")
        yield* until(Effect.sync(() => refreshes >= 2)).pipe(Effect.provideService(Clock.Clock, liveClock))
        expect(yield* llm.calls).toBe(1)
        expect(main.pollUnsafe()).toBeUndefined()
        clock.mockReturnValue(started + DEFAULT_TIMEOUT_MS)
        yield* TestClock.adjust("30 seconds")
        yield* llm.wait(2).pipe(Effect.timeout("5 seconds"), Effect.provideService(Clock.Clock, liveClock))
        const followup = JSON.stringify((yield* llm.inputs)[1]?.messages)
        expect(followup).toContain(WAIT_TIMEOUT_HINT)
        expect(followup).toContain("child-1")
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(messages.some((message) => message.info.role === "user" && message.parts.some(
          (part) => part.type === "text" && part.synthetic === true && part.text.includes(WAIT_TIMEOUT_HINT),
        ))).toBe(true)
        expect(yield* executions.current(session.id, "child-1")).toBe(held.execution)
        expect(held.fiber.pollUnsafe()).toBeUndefined()
        expect(held.execution.cancelled).toBe(false)
        expect(yield* Deferred.isDone(held.execution.done)).toBe(false)
        expect((yield* registry.get(session.id, "child-1"))?.status).toBe("running")
        clock.mockRestore()
        yield* complete(held)
        response.resolve()
        const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"), Effect.provideService(Clock.Clock, liveClock))
        if (structured) {
          expect(result.info.role).toBe("assistant")
          if (result.info.role === "assistant") {
            expect(result.info.error).toBeUndefined()
            expect(result.info.structured).toEqual({ answer: "MAIN-INSPECTED-TIMEOUT" })
          }
        } else expect(result.parts.some((part) => part.type === "text" && part.text === "MAIN-INSPECTED-TIMEOUT")).toBe(true)
        expect((yield* registry.get(session.id, "child-1"))?.lastOutcome).toBe("success")
        expect(yield* executions.current(session.id, "child-1")).toBeUndefined()
        expect(yield* llm.calls).toBe(2)
      }).pipe(Effect.provide(TestClock.layer()))
    }), { git: true, config }),
    20000,
  )

  for (const winner of ["user input", "child completion"] as const) it.live(
    `${winner} takes priority over an expired automatic wait deadline`,
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const liveClock = yield* Clock.Clock
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: `deadline versus ${winner}` })
        const held = yield* child(session.id)
        yield* llm.text("ORIGINAL-FINAL")
        const response = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => response.resolve()))
        if (winner === "user input") yield* llm.hold("ANSWER-NEW-USER", response.promise)
        const main = yield* start(session.id)
        yield* waiting(session.id).pipe(Effect.provideService(Clock.Clock, liveClock))
        const now = Date.now()
        const clock = yield* Effect.acquireRelease(
          Effect.sync(() => spyOn(Date, "now").mockReturnValue(now + DEFAULT_TIMEOUT_MS)),
          (spy) => Effect.sync(() => spy.mockRestore()),
        )
        if (winner === "user input") {
          yield* prompt.prompt({
            sessionID: session.id, agent: "build", noReply: true,
            parts: [{ type: "text", text: "PRIORITY-USER-INPUT" }],
          })
          yield* llm.wait(2).pipe(Effect.timeout("5 seconds"), Effect.provideService(Clock.Clock, liveClock))
          const followup = JSON.stringify((yield* llm.inputs)[1]?.messages)
          expect(followup).toContain("PRIORITY-USER-INPUT")
          expect(followup).not.toContain(WAIT_TIMEOUT_HINT)
          expect(held.execution.cancelled).toBe(false)
          expect(held.fiber.pollUnsafe()).toBeUndefined()
        }
        yield* complete(held)
        response.resolve()
        const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"), Effect.provideService(Clock.Clock, liveClock))
        const expected = winner === "user input" ? "ANSWER-NEW-USER" : "ORIGINAL-FINAL"
        expect(result.parts.some((part) => part.type === "text" && part.text === expected)).toBe(true)
        expect(JSON.stringify(yield* sessions.messages({ sessionID: session.id }))).not.toContain(WAIT_TIMEOUT_HINT)
        expect(yield* llm.calls).toBe(winner === "user input" ? 2 : 1)
        clock.mockRestore()
      }).pipe(Effect.provide(TestClock.layer()))
    }), { git: true, config }),
    20000,
  )

  for (const trigger of ["interrupted", "timeout"] as const) {
    it.live(
      `model actor wait ${trigger} reaches the next main model step without cancelling its real spawned child`,
      provideTmpdirServer(({ llm }) => Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const registry = yield* ActorRegistry.Service
        const executions = yield* ActorExecution.Service
        const session = yield* sessions.create({
          title: `real actor wait ${trigger}`,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const release = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
        yield* llm.pushMatch((hit) => {
          if (!Array.isArray(hit.body.messages)) return false
          const last = hit.body.messages.at(-1)
          return last?.role === "user" && JSON.stringify(last.content).includes("BLOCKED-WAIT-CHILD")
        }, reply().wait(release.promise).text("WAIT-CHILD-COMPLETED").stop())
        yield* llm.tool("actor", { operation: {
          action: "spawn", subagent_type: "general", description: "wait interruption child", prompt: "BLOCKED-WAIT-CHILD",
        } })
        yield* llm.tool("actor", { operation: {
          action: "wait", actor_id: "general-1", timeout_ms: trigger === "timeout" ? 1000 : 10000,
        } })
        yield* llm.text("MAIN-AFTER-WAIT")
        yield* llm.text("MAIN-AFTER-CHILD")
        const main = yield* start(session.id)
        yield* until(sessions.messages({ sessionID: session.id }).pipe(Effect.map((messages) => messages.some(
          (message) => message.parts.some((part) => part.type === "tool" && part.tool === "actor"
            && part.state.status === "running" && (part.state.input.operation as { action?: string })?.action === "wait"),
        ))))
        yield* llm.wait(3).pipe(Effect.timeout("5 seconds"))
        const execution = yield* executions.current(session.id, "general-1")
        if (!execution) throw new Error("spawn did not start general-1")
        expect(execution.fiber?.pollUnsafe()).toBeUndefined()
        expect(yield* llm.calls).toBe(3)
        if (trigger === "interrupted") yield* prompt.prompt({
          sessionID: session.id, agent: "build", noReply: true,
          parts: [{ type: "text", text: "NEW-USER-CONSTRAINT: answer me before the child finishes." }],
        })
        yield* llm.wait(4).pipe(Effect.timeout("5 seconds"))
        yield* waiting(session.id)
        const messages = yield* sessions.messages({ sessionID: session.id })
        const waitPart = messages.flatMap((message) => message.parts).find((part) => part.type === "tool"
          && part.tool === "actor" && part.state.status === "completed"
          && (part.state.input.operation as { action?: string })?.action === "wait")
        if (!waitPart || waitPart.type !== "tool" || waitPart.state.status !== "completed")
          throw new Error("model wait did not complete")
        expect(waitPart.state.output).toContain(`"status":"${trigger}"`)
        expect(waitPart.state.output).toContain('"executionActive":true')
        const followup = (yield* llm.inputs)[3]!
        expect(JSON.stringify(followup.messages)).toContain("general-1")
        const toolResults = (followup.messages as { role: string; content: unknown }[]).filter((message) => message.role === "tool")
        expect(JSON.stringify(toolResults)).toContain(trigger)
        if (trigger === "interrupted") expect(JSON.stringify(followup.messages)).toContain("NEW-USER-CONSTRAINT")
        else {
          expect(waitPart.state.output).toContain(WAIT_TIMEOUT_HINT)
          expect(JSON.stringify(toolResults)).toContain(WAIT_TIMEOUT_HINT)
        }
        expect(yield* executions.current(session.id, "general-1")).toBe(execution)
        expect(execution.fiber?.pollUnsafe()).toBeUndefined()
        expect(execution.cancelled).toBe(false)
        expect(yield* Deferred.isDone(execution.done)).toBe(false)
        expect((yield* registry.get(session.id, "general-1"))?.status).toBe("running")
        expect(main.pollUnsafe()).toBeUndefined()
        release.resolve()
        const result = yield* Fiber.join(main).pipe(Effect.timeout("10 seconds"))
        expect(result.parts.some((part) => part.type === "text" && part.text === "MAIN-AFTER-CHILD")).toBe(true)
        expect((yield* registry.get(session.id, "general-1"))?.lastOutcome).toBe("success")
        expect(yield* executions.current(session.id, "general-1")).toBeUndefined()
        expect(JSON.stringify((yield* llm.inputs)[4]?.messages)).toContain("WAIT-CHILD-COMPLETED")
        expect(yield* llm.calls).toBe(5)
      }), {
        git: true,
        config: (url) => ({ ...config(url), agent: { ...config(url).agent, general: { model: "alibaba/qwen-plus", completionGate: false } } }),
      }),
      25000,
    )
  }

  for (const [trigger, setup] of [["interrupted", false], ["timeout", false], ["abort", false], ["interrupted", true]] as const) {
    it.live(
      `model actor run ${trigger} preserves real child execution semantics${setup ? " during spawn setup" : ""}`,
      provideTmpdirServer(({ llm }) => Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const registry = yield* ActorRegistry.Service
        const executions = yield* ActorExecution.Service
        const state = yield* SessionRunState.Service
        const status = yield* SessionStatus.Service
        const session = yield* sessions.create({
          title: `real actor run ${trigger}`,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const notifications = yield* trackTerminalNotifications(session.id)
        const release = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
        yield* llm.pushMatch((hit) => {
          if (!Array.isArray(hit.body.messages)) return false
          const last = hit.body.messages.at(-1)
          return last?.role === "user" && JSON.stringify(last.content).includes("BLOCKED-RUN-CHILD")
        }, reply().wait(release.promise).text("RUN-CHILD-COMPLETED").stop())
        yield* llm.tool("actor", { operation: {
          action: "run", subagent_type: "general", description: "controlled inline child", prompt: "BLOCKED-RUN-CHILD",
          timeout_ms: trigger === "timeout" ? 1000 : 10000,
        } })
        yield* llm.text("MAIN-AFTER-RUN")
        yield* llm.text("MAIN-AFTER-RUN-CHILD")
        const entered = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        if (setup) yield* Effect.acquireRelease(Effect.sync(() => {
          const previous = spawnRef.current
          if (!previous) throw new Error("fixture did not initialize Actor")
          spawnRef.current = { ...previous, spawn: (input) => previous.spawn({
            ...input,
            onReady: (value) => Effect.gen(function* () {
              if (input.onReady) yield* input.onReady(value)
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(resume)
            }),
          }) }
          return previous
        }), (previous) => Effect.sync(() => { spawnRef.current = previous }))
        const main = yield* start(session.id)
        yield* until(sessions.messages({ sessionID: session.id }).pipe(Effect.map((messages) => messages.some(
          (message) => message.parts.some((part) => part.type === "tool" && part.tool === "actor"
            && part.state.status === "running" && (part.state.input.operation as { action?: string })?.action === "run"),
        ))))
        yield* llm.wait(2).pipe(Effect.timeout("5 seconds"))
        const execution = yield* executions.current(session.id, "general-1")
        if (!execution?.fiber) throw new Error("run did not start general-1 execution")
        expect(execution.fiber.pollUnsafe()).toBeUndefined()
        expect(yield* Deferred.isDone(execution.done)).toBe(false)
        expect(yield* llm.calls).toBe(2)
        if (trigger === "abort") {
          yield* prompt.cancel(session.id).pipe(Effect.timeout("5 seconds"))
          yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          yield* state.assertNotBusy(session.id, "main")
          expect((yield* status.get(session.id)).type).toBe("idle")
          expect(execution.groupAbort).toBe(true)
          expect(yield* Deferred.isDone(execution.done)).toBe(true)
          expect(execution.fiber.pollUnsafe()).toBeDefined()
          expect(yield* executions.current(session.id, "general-1")).toBeUndefined()
          expect((yield* registry.get(session.id, "general-1"))?.lastOutcome).toBe("cancelled")
          expect(JSON.stringify(yield* sessions.messages({ sessionID: session.id }))).not.toContain("RUN-CHILD-COMPLETED")
          expect(yield* llm.calls).toBe(2)
          return
        }
        if (setup) yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        if (trigger === "interrupted") yield* prompt.prompt({
          sessionID: session.id, agent: "build", noReply: true,
          parts: [{ type: "text", text: "RUN-NEW-USER-CONSTRAINT: answer me before the child finishes." }],
        })
        if (setup) {
          expect(yield* llm.calls).toBe(2)
          yield* Deferred.succeed(resume, undefined)
        }
        yield* llm.wait(3).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchTag("TimeoutError", () => Effect.die(new Error(`main model did not resume after run ${trigger}`))),
        )
        yield* waiting(session.id).pipe(
          Effect.catchTag("TimeoutError", () => Effect.die(new Error(`main did not wait for live child after run ${trigger}`))),
        )
        yield* busy(session.id)
        const messages = yield* sessions.messages({ sessionID: session.id })
        const runPart = messages.flatMap((message) => message.parts).find((part) => part.type === "tool"
          && part.tool === "actor" && part.state.status === "completed"
          && (part.state.input.operation as { action?: string })?.action === "run")
        if (!runPart || runPart.type !== "tool" || runPart.state.status !== "completed")
          throw new Error("model run did not complete")
        expect(runPart.state.output).toContain(`"status":"${trigger}"`)
        expect(runPart.state.output).toContain('"actor_id":"general-1"')
        expect(runPart.state.output).toContain('"executionActive":true')
        expect(runPart.state.metadata.actorId).toBe("general-1")
        expect(runPart.state.metadata.status).toBe(trigger)
        const followup = (yield* llm.inputs)[2]!
        const toolResults = (followup.messages as { role: string; content: unknown }[]).filter((message) => message.role === "tool")
        expect(JSON.stringify(toolResults)).toContain(trigger)
        expect(JSON.stringify(toolResults)).toContain("general-1")
        if (trigger === "interrupted") expect(JSON.stringify(followup.messages)).toContain("RUN-NEW-USER-CONSTRAINT")
        else {
          expect(runPart.state.output).toContain(WAIT_TIMEOUT_HINT)
          expect(JSON.stringify(toolResults)).toContain(WAIT_TIMEOUT_HINT)
        }
        expect(yield* executions.current(session.id, "general-1")).toBe(execution)
        expect(execution.fiber.pollUnsafe()).toBeUndefined()
        expect(execution.cancelled).toBe(false)
        expect(yield* Deferred.isDone(execution.done)).toBe(false)
        expect((yield* registry.get(session.id, "general-1"))?.status).toBe("running")
        expect(main.pollUnsafe()).toBeUndefined()
        expect(notifications).toHaveLength(0)
        release.resolve()
        const result = yield* Fiber.join(main).pipe(Effect.timeout("10 seconds"))
        expect(notifications).toHaveLength(1)
        expect(notifications[0]).toContain("RUN-CHILD-COMPLETED")
        expect(result.parts.some((part) => part.type === "text" && part.text === "MAIN-AFTER-RUN-CHILD")).toBe(true)
        expect((yield* registry.get(session.id, "general-1"))?.lastOutcome).toBe("success")
        expect(yield* executions.current(session.id, "general-1")).toBeUndefined()
        expect(yield* Deferred.isDone(execution.done)).toBe(true)
        expect(execution.cancelled).toBe(false)
        expect(JSON.stringify((yield* llm.inputs)[3]?.messages)).toContain("RUN-CHILD-COMPLETED")
        expect(yield* llm.calls).toBe(4)
      }), {
        git: true,
        config: (url) => ({ ...config(url), agent: { ...config(url).agent, general: { model: "alibaba/qwen-plus", completionGate: false } } }),
      }),
      25000,
    )
  }

  for (const outcome of ["success", "failure"] as const) it.live(
    `model actor run ${outcome} returns inline without a duplicate terminal notification`,
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const registry = yield* ActorRegistry.Service
      const executions = yield* ActorExecution.Service
      const session = yield* sessions.create({
        title: `inline run ${outcome}`, permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const notifications = yield* trackTerminalNotifications(session.id)
      yield* llm.pushMatch((hit) => {
        if (!Array.isArray(hit.body.messages)) return false
        const last = hit.body.messages.at(-1)
        return last?.role === "user" && JSON.stringify(last.content).includes("INLINE-RUN-CHILD")
      }, outcome === "success" ? reply().text("INLINE-CHILD-RESULT").stop() : {
        type: "http-error", status: 401, body: { error: { message: "INLINE-CHILD-FAILURE", type: "authentication_error" } },
      })
      yield* llm.tool("actor", { operation: {
        action: "run", subagent_type: "general", description: "inline result ownership", prompt: "INLINE-RUN-CHILD",
      } })
      yield* llm.text("MAIN-INLINE-FINAL")
      const main = yield* start(session.id)
      const result = yield* Fiber.join(main).pipe(Effect.timeout("10 seconds"))
      expect(result.parts.some((part) => part.type === "text" && part.text === "MAIN-INLINE-FINAL")).toBe(true)
      const messages = yield* sessions.messages({ sessionID: session.id })
      const runPart = messages.flatMap((message) => message.parts).find((part) => part.type === "tool"
        && part.tool === "actor" && (part.state.input.operation as { action?: string })?.action === "run")
      if (!runPart || runPart.type !== "tool") throw new Error("inline run tool missing")
      expect(runPart.state.status).toBe(outcome === "success" ? "completed" : "error")
      if (runPart.state.status === "completed") expect(runPart.state.output).toContain("INLINE-CHILD-RESULT")
      if (runPart.state.status === "error") expect(runPart.state.error).toContain("Tool execution failed: Error: Actor assistant failed: APIError")
      expect((yield* registry.get(session.id, "general-1"))?.lastOutcome).toBe(outcome)
      expect(yield* executions.current(session.id, "general-1")).toBeUndefined()
      expect(notifications).toHaveLength(0)
      expect(yield* llm.calls).toBe(3)
    }), {
      git: true,
      config: (url) => ({ ...config(url), agent: { ...config(url).agent, general: { model: "alibaba/qwen-plus", completionGate: false } } }),
    }),
    20000,
  )

  for (const phase of ["pre-aborted", "onActorID", "onReady"] as const) it.live(
    `tool actor run abort at ${phase} does not leave a real child execution`,
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const registry = yield* ActorRegistry.Service
      const executions = yield* ActorExecution.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: `run setup abort ${phase}` })
      yield* Effect.addFinalizer(() => prompt.cancel(session.id))
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: session.id, role: "user", agent: "build",
        model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }, time: { created: Date.now() },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: session.id, role: "assistant", parentID: user.id, agent: "build", mode: "build",
        providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus"), cost: 0,
        path: { cwd: "/tmp", root: "/tmp" }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      const controller = new AbortController()
      const entered = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      yield* llm.hold("SETUP-CHILD-MUST-NOT-COMPLETE", release.promise)
      let spawns = 0
      let execution: Effect.Success<ReturnType<typeof executions.current>>
      yield* Effect.acquireRelease(Effect.sync(() => {
        const previous = spawnRef.current
        if (!previous) throw new Error("fixture did not initialize Actor")
        spawnRef.current = { ...previous, spawn: (input) => {
          spawns++
          return previous.spawn({ ...input, onActorID: (id) => {
            execution = executions.currentUnsafe(session.id, id)
            if (phase === "onActorID") controller.abort()
            input.onActorID?.(id)
          } })
        } }
        return previous
      }), (previous) => Effect.sync(() => { spawnRef.current = previous }))
      if (phase === "pre-aborted") controller.abort()
      const tool = yield* ActorTool
      const def = yield* tool.init()
      const running = yield* def.execute({ operation: {
        action: "run", subagent_type: "general", description: "setup cancellation", prompt: "SETUP-CHILD", timeout_ms: 10000,
      } }, {
        sessionID: session.id, messageID: assistant.id, agent: "build", abort: controller.signal, extra: {}, messages: [],
        ask: () => Effect.void,
        metadata: () => phase === "onReady" ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))) : Effect.void,
      }).pipe(Effect.exit, Effect.forkChild)
      if (phase === "onReady") {
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
        expect(execution?.fiber?.pollUnsafe()).toBeUndefined()
        controller.abort()
        yield* Deferred.succeed(resume, undefined)
      }
      const exit = yield* Fiber.join(running).pipe(Effect.timeout("5 seconds"))
      expect(spawns).toBe(phase === "pre-aborted" ? 0 : 1)
      if (phase === "pre-aborted") {
        expect(Exit.isFailure(exit)).toBe(true)
        expect((yield* registry.listBySession(session.id)).filter((actor) => actor.agent === "general")).toHaveLength(0)
      } else {
        if (!execution) throw new Error("setup did not reserve execution")
        yield* Deferred.await(execution.done).pipe(Effect.timeout("5 seconds"))
        expect(execution.cancelled).toBe(true)
        expect((yield* registry.get(session.id, "general-1"))?.lastOutcome).toBe("cancelled")
        expect(yield* executions.current(session.id, "general-1")).toBeUndefined()
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) expect(exit.value.output).toContain('<actor_result status="cancelled">')
      }
      expect(yield* terminalNotifications(session.id)).toHaveLength(0)
      expect(yield* llm.calls).toBe(phase === "onReady" ? 1 : 0)
      expect(JSON.stringify(yield* sessions.messages({ sessionID: session.id }))).not.toContain("SETUP-CHILD-MUST-NOT-COMPLETE")
    }), {
      git: true,
      config: (url) => ({ ...config(url), agent: { ...config(url).agent, general: { model: "alibaba/qwen-plus", completionGate: false } } }),
    }),
    20000,
  )

  it.live(
    "model actor run timeout terminal delivery cannot wake main across session abort",
    provideTmpdirServer(({ llm }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const executions = yield* ActorExecution.Service
      const inbox = inboxServiceRef.current
      if (!inbox) throw new Error("fixture did not initialize Inbox")
      const tq = yield* TurnQueue.Service
      const session = yield* sessions.create({
        title: "abort during run notification delivery", permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      const entered = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const settled = yield* Deferred.make<void>()
      yield* Effect.acquireRelease(Effect.sync(() => {
        const previous = inbox.send
        Object.assign(inbox, { send: (input: Parameters<typeof previous>[0]) => {
          if (input.receiverSessionID !== session.id || input.receiverActorID !== "main"
            || input.senderActorID !== "general-1" || input.type !== "actor_notification") return previous(input)
          return Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(resume)
            return yield* previous(input)
          }).pipe(Effect.ensuring(Deferred.succeed(settled, undefined)))
        } })
        return previous
      }), (previous) => Effect.sync(() => { Object.assign(inbox, { send: previous }) }))
      yield* llm.pushMatch((hit) => {
        if (!Array.isArray(hit.body.messages)) return false
        const last = hit.body.messages.at(-1)
        return last?.role === "user" && JSON.stringify(last.content).includes("NOTIFY-BARRIER-CHILD")
      }, reply().wait(release.promise).text("NOTIFY-BARRIER-RESULT").stop())
      yield* llm.tool("actor", { operation: {
        action: "run", subagent_type: "general", description: "abort notification handoff", prompt: "NOTIFY-BARRIER-CHILD", timeout_ms: 1000,
      } })
      yield* llm.text("MAIN-BEFORE-NOTIFY-ABORT")
      yield* llm.text("MUST-NOT-WAKE-AFTER-ABORT")
      const main = yield* start(session.id)
      yield* Effect.addFinalizer(() => Deferred.succeed(resume, undefined))
      yield* llm.wait(3).pipe(Effect.timeout("5 seconds"))
      yield* waiting(session.id)
      const execution = yield* executions.current(session.id, "general-1")
      if (!execution) throw new Error("run child execution missing before handoff")
      expect(execution.cancelled).toBe(false)
      release.resolve()
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
      expect(yield* terminalNotifications(session.id)).toHaveLength(0)
      const epoch = yield* tq.getEpoch(session.id)
      const cancellation = yield* prompt.cancel(session.id).pipe(Effect.forkChild)
      yield* until(Effect.sync(() => execution.groupAbort === true || cancellation.pollUnsafe() !== undefined))
      expect(yield* tq.getEpoch(session.id)).toBeGreaterThan(epoch)
      yield* Deferred.succeed(resume, undefined)
      yield* Deferred.await(settled).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.join(cancellation).pipe(Effect.timeout("5 seconds"))
      yield* Deferred.await(execution.done).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
      const receipts = Database.use((db) => db.select().from(TurnReceiptTable).where(and(
        eq(TurnReceiptTable.session_id, session.id), eq(TurnReceiptTable.agent_id, "main"),
      )).all())
      expect(receipts.filter((receipt) => receipt.epoch > epoch && receipt.intent.kind === "wake")).toHaveLength(0)
      expect(yield* llm.calls).toBe(3)
      expect(yield* executions.current(session.id, "general-1")).toBeUndefined()
      expect(JSON.stringify(yield* sessions.messages({ sessionID: session.id }))).not.toContain("MUST-NOT-WAKE-AFTER-ABORT")
    }), {
      git: true,
      config: (url) => ({ ...config(url), agent: { ...config(url).agent, general: { model: "alibaba/qwen-plus", completionGate: false } } }),
    }),
    20000,
  )

  it.live(
    "model actor run timeout cannot admit or dispatch a wake between abort epoch bump and group marking",
    provideTmpdirServer(({ llm, dir }) => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const executions = yield* ActorExecution.Service
      const tq = yield* TurnQueue.Service
      const session = yield* sessions.create({
        title: "run notification at abort epoch boundary", permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const toasts: string[] = []
      const onEvent = (event: GlobalEvent) => {
        if (event.directory === dir && event.payload.type === TuiEvent.ToastShow.type
          && event.payload.properties.message.includes('Child "epoch window child"')) toasts.push(event.payload.properties.message)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", onEvent)),
        () => Effect.sync(() => GlobalBus.off("event", onEvent)),
      )
      const releaseChild = Promise.withResolvers<void>()
      const releaseMain = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => { releaseChild.resolve(); releaseMain.resolve() }))
      const epochBumped = yield* Deferred.make<void>()
      const resumeCancel = yield* Deferred.make<void>()
      const dispatchEntered = yield* Deferred.make<void>()
      const resumeDispatch = yield* Deferred.make<void>()
      const dispatchSettled = yield* Deferred.make<void>()
      let delayed = false
      let dispatches = 0
      yield* Effect.acquireRelease(Effect.sync(() => {
        const previous = turnQueueRef.current
        if (!previous) throw new Error("fixture did not initialize TurnQueue")
        turnQueueRef.current = { ...previous, abortSession: (sessionID, policy) => Effect.gen(function* () {
          const epoch = yield* previous.abortSession(sessionID, policy)
          if (sessionID === session.id && !delayed) {
            delayed = true
            yield* Deferred.succeed(epochBumped, undefined)
            yield* Deferred.await(resumeCancel)
          }
          return epoch
        }) }
        return previous
      }), (previous) => Effect.sync(() => { turnQueueRef.current = previous }))
      yield* Effect.acquireRelease(Effect.sync(() => {
        const previous = sessionPromptRef.current
        if (!previous) throw new Error("fixture did not initialize SessionPrompt")
        sessionPromptRef.current = { ...previous, loop: (input) => {
          if (input.sessionID !== session.id || input.agentID !== "main" || !input.inboxWake) return previous.loop(input)
          dispatches++
          return Effect.gen(function* () {
            yield* Deferred.succeed(dispatchEntered, undefined)
            yield* Deferred.await(resumeDispatch)
            return yield* previous.loop(input)
          }).pipe(Effect.ensuring(Deferred.succeed(dispatchSettled, undefined)))
        } }
        return previous
      }), (previous) => Effect.sync(() => { sessionPromptRef.current = previous }))
      yield* llm.pushMatch((hit) => {
        if (!Array.isArray(hit.body.messages)) return false
        const last = hit.body.messages.at(-1)
        return last?.role === "user" && JSON.stringify(last.content).includes("EPOCH-WINDOW-CHILD")
      }, reply().wait(releaseChild.promise).text("EPOCH-WINDOW-CHILD-RESULT").stop())
      yield* llm.tool("actor", { operation: {
        action: "run", subagent_type: "general", description: "epoch window child", prompt: "EPOCH-WINDOW-CHILD", timeout_ms: 1000,
      } })
      yield* llm.hold("MAIN-HELD-DURING-EPOCH-ABORT", releaseMain.promise)
      yield* llm.text("MUST-NOT-DISPATCH-IN-NEW-EPOCH")
      const main = yield* start(session.id)
      yield* Effect.addFinalizer(() => Effect.gen(function* () {
        yield* Deferred.succeed(resumeCancel, undefined)
        yield* Deferred.succeed(resumeDispatch, undefined)
      }))
      yield* llm.wait(3).pipe(Effect.timeout("5 seconds"))
      const runPart = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "actor" && part.state.status === "completed"
          && (part.state.input.operation as { action?: string })?.action === "run")
      if (!runPart || runPart.type !== "tool" || runPart.state.status !== "completed") throw new Error("run did not time out")
      expect(runPart.state.output).toContain(WAIT_TIMEOUT_HINT)
      const execution = yield* executions.current(session.id, "general-1")
      if (!execution) throw new Error("run child execution missing at epoch boundary")
      const oldEpoch = yield* tq.getEpoch(session.id)
      const cancellation = yield* prompt.cancel(session.id).pipe(Effect.forkChild)
      yield* Deferred.await(epochBumped).pipe(Effect.timeout("5 seconds"))
      expect(yield* tq.getEpoch(session.id)).toBeGreaterThan(oldEpoch)
      expect(cancellation.pollUnsafe()).toBeUndefined()
      expect(yield* Deferred.isDone(execution.done)).toBe(false)
      releaseChild.resolve()
      yield* Deferred.await(execution.done).pipe(Effect.timeout("5 seconds"))
      const newEpochWakes = () => Database.use((db) => db.select().from(TurnReceiptTable).where(and(
        eq(TurnReceiptTable.session_id, session.id), eq(TurnReceiptTable.agent_id, "main"),
      )).all()).filter((receipt) => receipt.epoch > oldEpoch && receipt.intent.kind === "wake")
      if (newEpochWakes().length > 0) yield* Deferred.await(dispatchEntered).pipe(Effect.timeout("5 seconds"))
      expect(yield* llm.calls).toBe(3)
      yield* Deferred.succeed(resumeCancel, undefined)
      yield* Fiber.join(cancellation).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
      yield* Deferred.succeed(resumeDispatch, undefined)
      if (dispatches > 0) yield* Deferred.await(dispatchSettled).pipe(Effect.timeout("5 seconds"))
      expect(newEpochWakes()).toHaveLength(0)
      expect(dispatches).toBe(0)
      expect(yield* llm.calls).toBe(3)
      expect(yield* executions.current(session.id, "general-1")).toBeUndefined()
      expect(JSON.stringify(yield* sessions.messages({ sessionID: session.id }))).not.toContain("MUST-NOT-DISPATCH-IN-NEW-EPOCH")
      expect(toasts).toHaveLength(0)
    }), {
      git: true,
      config: (url) => ({ ...config(url), agent: { ...config(url).agent, general: { model: "alibaba/qwen-plus", completionGate: false } } }),
    }),
    20000,
  )

  for (const outcome of ["orphan", "success", "failure"] as const) {
    it.live(
      outcome === "orphan"
        ? "an orphan running row without execution is failed and reported instead of waiting forever"
        : `an execution that exited with ${outcome} without release is failed and reported to main`,
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const registry = yield* ActorRegistry.Service
            const executions = yield* ActorExecution.Service
            const session = yield* sessions.create({ title: "orphan child" })
            yield* register(session.id, "orphan-1")
            const execution =
              outcome !== "orphan"
                ? yield* Effect.acquireRelease(executions.reserve(session.id, "orphan-1"), executions.release)
                : undefined
            if (execution) {
              const fiber = yield* executions.fork(
                execution,
                outcome === "failure" ? Effect.die(new Error("child execution crashed")) : Effect.void,
                yield* Effect.scope,
              )
              yield* Fiber.await(fiber)
              expect(yield* Deferred.isDone(execution.done)).toBe(false)
            }
            yield* llm.text("FIRST-FINAL")
            yield* llm.text("ACKNOWLEDGED-CHILD-FAILURE")
            const main = yield* start(session.id)
            const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
            const actor = yield* registry.get(session.id, "orphan-1")
            expect(actor?.status).toBe("idle")
            expect(actor?.lastOutcome).toBe("failure")
            expect(actor?.lastError).toContain(
              outcome === "failure" ? "child execution crashed" : "no active execution",
            )
            expect(yield* executions.current(session.id, "orphan-1")).toBeUndefined()
            if (execution) expect(yield* Deferred.isDone(execution.done)).toBe(true)
            expect(yield* llm.calls).toBe(2)
            const followup = JSON.stringify((yield* llm.inputs)[1]?.messages)
            expect(followup).toContain("actor-notification")
            expect(followup).toContain("orphan-1")
            expect(followup).toContain("failed")
            expect(
              result.parts.some((part) => part.type === "text" && part.text === "ACKNOWLEDGED-CHILD-FAILURE"),
            ).toBe(true)
          }),
        { git: true, config },
      ),
      20000,
    )
  }

  it.live(
    "explicit cancel exits the main wait and releases its still-pending child",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const state = yield* SessionRunState.Service
          const status = yield* SessionStatus.Service
          const executions = yield* ActorExecution.Service
          const session = yield* sessions.create({ title: "cancel main wait" })
          const held = yield* child(session.id)
          yield* llm.text("MAIN-FINAL")
          const main = yield* start(session.id)
          yield* waiting(session.id)
          yield* busy(session.id)
          yield* prompt.cancel(session.id).pipe(Effect.timeout("5 seconds"))
          yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          yield* state.assertNotBusy(session.id, "main")
          expect((yield* status.get(session.id)).type).toBe("idle")
          expect(held.execution.groupAbort).toBe(true)
          expect(held.execution.cancelled).toBe(true)
          expect(yield* Deferred.isDone(held.execution.done)).toBe(true)
          expect(yield* Deferred.isDone(held.finish)).toBe(false)
          expect(yield* executions.current(session.id, "child-1")).toBeUndefined()
          expect(yield* llm.calls).toBe(1)
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "structured success remains busy until the real child execution completes",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({ title: "structured wait" })
          const held = yield* child(session.id)
          yield* llm.tool("StructuredOutput", { answer: "structured result" })
          yield* Effect.addFinalizer(() => prompt.cancel(session.id))
          const main = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "Return the answer in the schema." }],
              format: {
                type: "json_schema",
                schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
                retryCount: 0,
              },
            })
            .pipe(Effect.forkChild)
          yield* waiting(session.id)
          yield* busy(session.id)
          expect(main.pollUnsafe()).toBeUndefined()
          expect(yield* llm.calls).toBe(1)
          yield* complete(held)
          const result = yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          expect(result.info.role).toBe("assistant")
          if (result.info.role === "assistant") {
            expect(result.info.error).toBeUndefined()
            expect(result.info.structured).toEqual({ answer: "structured result" })
          }
          expect(yield* llm.calls).toBe(1)
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "system actors, peers, and another session's live child do not block main final",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "unrelated children" })
          const other = yield* sessions.create({ title: "other session" })
          const system = yield* child(session.id, "writer-1", "checkpoint-writer")
          const peer = yield* child(session.id, "peer-1", "general", "peer")
          const foreign = yield* child(other.id)
          yield* llm.text("MAIN-FINAL")
          const main = yield* start(session.id)
          yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          for (const held of [system, peer, foreign]) {
            expect(held.fiber.pollUnsafe()).toBeUndefined()
            expect(held.execution.cancelled).toBe(false)
            yield* complete(held)
          }
          expect(yield* llm.calls).toBe(1)
        }),
      { git: true, config },
    ),
    20000,
  )

  it.live(
    "a silent but live execution survives the 30-second refresh without being declared dead",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const registry = yield* ActorRegistry.Service
          const session = yield* sessions.create({ title: "stalled is not dead" })
          const held = yield* child(session.id)
          // Keep the independent background stall watchdog from sending main a new notification.
          Database.use((db) =>
            db
              .update(ActorRegistryTable)
              .set({ background: false, last_activity_time: Date.now() - DEFAULT_LIVENESS_STALL_MS - 60000 })
              .where(and(eq(ActorRegistryTable.session_id, session.id), eq(ActorRegistryTable.actor_id, "child-1")))
              .run(),
          )
          yield* llm.text("MAIN-FINAL")
          const main = yield* start(session.id)
          yield* waiting(session.id)
          yield* busy(session.id)
          expect((yield* registry.liveness(session.id, "child-1"))?.liveness).toBe("stalled")
          yield* Effect.sleep("31 seconds")
          yield* busy(session.id)
          expect(main.pollUnsafe()).toBeUndefined()
          expect(held.fiber.pollUnsafe()).toBeUndefined()
          expect(yield* Deferred.isDone(held.execution.done)).toBe(false)
          expect((yield* registry.get(session.id, "child-1"))?.lastOutcome).toBeUndefined()
          expect(yield* llm.calls).toBe(1)
          yield* complete(held)
          yield* Fiber.join(main).pipe(Effect.timeout("5 seconds"))
          expect((yield* registry.get(session.id, "child-1"))?.lastOutcome).toBe("success")
        }),
      { git: true, config },
    ),
    45000,
  )
})
