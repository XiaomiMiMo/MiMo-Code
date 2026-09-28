import { ActorExecution } from "../../src/actor/execution"
import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Scheduler } from "effect"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { SessionRunState } from "../../src/session/run-state"
import { Database, and, eq } from "../../src/storage"
import { Bus } from "../../src/bus"
import { Session as SessionNs } from "../../src/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { runTurn } from "../../src/actor/turn"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ProviderID, ModelID } from "../../src/provider/schema"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Bus.layer,
  ActorRegistry.defaultLayer,
  SessionRunState.defaultLayer,
  ActorWaiter.layer.pipe(
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionNs.defaultLayer),
  ),
)

const it = testEffect(env)

// Helper: seed an assistant message with a text part in the actor's slice.
// Mirrors the pattern in test/session/revert-compact.test.ts.
const seedAssistantText = (sessionID: SessionID, actorID: string, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    // First seed a parent user message so parentID is valid
    const userMsg = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user" as const,
      sessionID,
      agentID: actorID,
      time: { created: Date.now() },
      agent: "general",
      model: {
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
      },
    })
    const msgID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: msgID,
      role: "assistant" as const,
      sessionID,
      agentID: actorID,
      mode: "default",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test"),
      parentID: userMsg.id,
      time: { created: Date.now() },
      finish: "end_turn",
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msgID,
      sessionID,
      type: "text" as const,
      text,
    })
  })

const statusFixture = Effect.gen(function* () {
  const sessions = yield* SessionNs.Service
  const registry = yield* ActorRegistry.Service
  const waiter = yield* ActorWaiter.Service
  const executions = yield* ActorExecution.Service
  const session = yield* sessions.create({ title: "execution projection" })
  const entry = yield* registry.register({
    sessionID: session.id,
    actorID: "child",
    mode: "subagent",
    agent: "general",
    description: "controlled child",
    contextMode: "none",
    background: true,
    lifecycle: "ephemeral",
  })
  return { sessions, registry, waiter, executions, entry }
})

const terminalDelivery = (sessionID: SessionID, lastOutcome: "success" | "failure" | "cancelled") =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    const registry = yield* ActorRegistry.Service
    yield* seedAssistantText(sessionID, "child", "PREVIOUS-RESULT")
    const message = (yield* sessions.messages({ sessionID, agentID: "child" })).findLast(
      (message) => message.info.role === "assistant",
    )!
    if (message.info.role !== "assistant") throw new Error("missing assistant")
    yield* sessions.updateMessage({ ...message.info, actorResult: { finalText: "PREVIOUS-RESULT" } })
    yield* registry.updateStatus(sessionID, "child", {
      status: "idle",
      lastOutcome,
      lastError: lastOutcome === "failure" ? "PREVIOUS-ERROR" : undefined,
      resultMessageID: message.info.id,
    })
    return (yield* registry.get(sessionID, "child"))!
  })

const expectNoTerminal = (entry: Effect.Success<ReturnType<ActorWaiter.Interface["status"]>>) => {
  expect(entry.lastOutcome).toBeUndefined()
  expect(entry.lastError).toBeUndefined()
  expect(entry.resultMessageID).toBeUndefined()
  expect(entry.time.completed).toBeUndefined()
}

const expectNoDelivery = (snapshot: ActorWaiter.WaitResult) => {
  expect(snapshot.lastOutcome).toBeUndefined()
  expect(snapshot.error).toBeUndefined()
  expect(snapshot.result).toBeUndefined()
  expect(snapshot.structured).toBeUndefined()
  expect(snapshot.time?.completed).toBeUndefined()
}

describe("ActorWaiter.status — actual execution and fresh registry projection", () => {
  it.live(
    "a reservation before attach and its live fiber are active",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { entry, waiter, executions } = yield* statusFixture
        const execution = yield* Effect.acquireRelease(
          executions.reserve(entry.sessionID, entry.actorID),
          executions.release,
        )
        expect(execution.fiber).toBeUndefined()
        expect(yield* Deferred.isDone(execution.done)).toBe(false)
        const reserved = yield* waiter.status(entry)
        expect(reserved.status).toBe("running")
        expect(reserved.executionActive).toBe(true)
        expect(reserved.executionState).toBe("running")
        const finish = yield* Deferred.make<void>()
        const fiber = yield* executions.fork(
          execution,
          Deferred.await(finish).pipe(Effect.interruptible),
          yield* Effect.scope,
        )
        expect(fiber.pollUnsafe()).toBeUndefined()
        const active = yield* waiter.status(entry)
        expect(active.executionActive).toBe(true)
        expect(active.executionState).toBe("running")
        yield* Deferred.succeed(finish, undefined)
        yield* Fiber.join(fiber)
      }),
    ),
  )

  for (const outcome of ["success", "failure", "cancelled"] as const) {
    it.live(
      `an exited ${outcome} fiber is inactive even before ActorExecution.release`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { entry, waiter, executions } = yield* statusFixture
          const execution = yield* Effect.acquireRelease(
            executions.reserve(entry.sessionID, entry.actorID),
            executions.release,
          )
          const work =
            outcome === "failure"
              ? Effect.die("execution crashed")
              : outcome === "cancelled"
                ? Effect.interrupt
                : Effect.void
          const fiber = yield* executions.fork(execution, work, yield* Effect.scope)
          yield* Fiber.await(fiber)
          expect(fiber.pollUnsafe()).toBeDefined()
          expect(yield* executions.current(entry.sessionID, entry.actorID)).toBe(execution)
          expect(yield* Deferred.isDone(execution.done)).toBe(false)
          const current = yield* waiter.status(entry)
          expect(current.status).toBe("idle")
          expect(current.executionActive).toBe(false)
          expect(current.executionState).toBe("stopped")
          expectNoTerminal(current)
        }),
      ),
    )
  }

  it.live(
    "a real live legacy Runner is active without an ActorExecution",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { entry, waiter, executions } = yield* statusFixture
        const runs = yield* SessionRunState.Service
        yield* Effect.addFinalizer(() => runs.cancelActor(entry.sessionID, entry.actorID))
        yield* runs.start(entry.sessionID, entry.actorID, Effect.never, Effect.never)
        const legacy = yield* runs.executionSnapshot(entry.sessionID, entry.actorID)
        expect(legacy.fiber).toBeDefined()
        expect(legacy.fiber?.pollUnsafe()).toBeUndefined()
        expect(yield* executions.current(entry.sessionID, entry.actorID)).toBeUndefined()
        const current = yield* waiter.status(entry)
        expect(current.status).toBe("running")
        expect(current.executionActive).toBe(true)
        expect(current.executionState).toBe("running")
      }),
    ),
  )

  it.live(
    "a legacy Runner interrupted before work starts is inactive despite its stale busy ledger",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { entry, waiter, executions } = yield* statusFixture
        const runs = yield* SessionRunState.Service
        let started = false
        const fiber = yield* Effect.gen(function* () {
          yield* runs.start(
            entry.sessionID,
            entry.actorID,
            Effect.never,
            Effect.sync(() => {
              started = true
            }).pipe(Effect.andThen(Effect.never)),
          )
          const legacy = yield* runs.executionSnapshot(entry.sessionID, entry.actorID)
          if (!legacy.fiber) throw new Error("legacy runner did not start")
          legacy.fiber.interruptUnsafe()
          return legacy.fiber
        }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true))
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(started).toBe(false)
        expect(Exit.isFailure(yield* runs.assertNotBusy(entry.sessionID, entry.actorID).pipe(Effect.exit))).toBe(true)
        expect(yield* executions.current(entry.sessionID, entry.actorID)).toBeUndefined()
        const current = yield* waiter.status(entry)
        expect(current.executionActive).toBe(false)
        expect(current.executionState).toBe("stopped")
        expectNoTerminal(current)
      }),
    ),
  )

  for (const status of ["pending", "running"] as const) {
    for (const outcome of ["success", "failure", "cancelled"] as const) {
      it.live(
        `raw ${status} without execution does not reuse previous ${outcome} metadata or delivery`,
        provideTmpdirInstance(() =>
          Effect.gen(function* () {
            const { entry, waiter, registry } = yield* statusFixture
            const previous = yield* terminalDelivery(entry.sessionID, outcome)
            Database.use((db) =>
              db
                .update(ActorRegistryTable)
                .set({ status })
                .where(
                  and(
                    eq(ActorRegistryTable.session_id, entry.sessionID),
                    eq(ActorRegistryTable.actor_id, entry.actorID),
                  ),
                )
                .run(),
            )
            const raw = (yield* registry.get(entry.sessionID, entry.actorID))!
            expect(raw.lastOutcome).toBe(outcome)
            expect(raw.resultMessageID).toBe(previous.resultMessageID)
            expect(raw.time.completed).toBeDefined()
            const current = yield* waiter.status(raw)
            expect(current.status).toBe("idle")
            expect(current.executionActive).toBe(false)
            expect(current.executionState).toBe("stopped")
            expectNoTerminal(current)
            const snapshot = yield* waiter.wait({ sessionID: entry.sessionID, actor_id: entry.actorID, timeout_ms: 20 })
            expect(snapshot.executionActive).toBe(false)
            expect(snapshot.executionState).toBe("stopped")
            expectNoDelivery(snapshot)
            expect(yield* registry.get(entry.sessionID, entry.actorID)).toEqual(raw)
          }),
        ),
      )
    }
  }

  for (const outcome of ["success", "failure", "cancelled"] as const) {
    it.live(
      `current idle ${outcome} retains its trusted terminal metadata`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { entry, waiter } = yield* statusFixture
          const terminal = yield* terminalDelivery(entry.sessionID, outcome)
          const current = yield* waiter.status(terminal)
          expect(current).toEqual({
            ...terminal,
            executionActive: false,
            executionState: outcome === "success" ? "completed" : outcome === "failure" ? "failed" : "cancelled",
          })
          const snapshot = yield* waiter.wait({ sessionID: entry.sessionID, actor_id: entry.actorID })
          expect(snapshot.lastOutcome).toBe(outcome)
          expect(snapshot.time?.completed).toBe(terminal.time.completed)
          expect(snapshot.error).toBe(terminal.lastError)
          expect(snapshot.result).toBe(outcome === "cancelled" ? undefined : "PREVIOUS-RESULT")
        }),
      ),
    )
  }

  it.live(
    "an old running snapshot cannot hide a newly committed success",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { entry, waiter, registry, executions } = yield* statusFixture
        yield* registry.updateStatus(entry.sessionID, entry.actorID, { status: "running" })
        const old = (yield* registry.get(entry.sessionID, entry.actorID))!
        const execution = yield* Effect.acquireRelease(
          executions.reserve(entry.sessionID, entry.actorID),
          executions.release,
        )
        const fiber = yield* executions.fork(execution, Effect.void, yield* Effect.scope)
        yield* Fiber.join(fiber)
        const terminal = yield* terminalDelivery(entry.sessionID, "success")
        yield* executions.release(execution)
        const current = yield* waiter.status(old)
        expect(current).toEqual({ ...terminal, executionActive: false, executionState: "completed" })
        expect(yield* registry.get(entry.sessionID, entry.actorID)).toEqual(terminal)
      }),
    ),
  )

  for (const live of [false, true]) {
    it.live(
      `an old success snapshot sees a resumed running row ${live ? "with" : "without"} a live execution`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { entry, waiter, registry, executions } = yield* statusFixture
          const old = yield* terminalDelivery(entry.sessionID, "success")
          yield* registry.updateStatus(entry.sessionID, entry.actorID, { status: "running" })
          yield* registry.updateTurn(entry.sessionID, entry.actorID)
          if (live) {
            const execution = yield* Effect.acquireRelease(
              executions.reserve(entry.sessionID, entry.actorID),
              executions.release,
            )
            const fiber = yield* executions.fork(
              execution,
              Effect.never.pipe(Effect.interruptible),
              yield* Effect.scope,
            )
            expect(fiber.pollUnsafe()).toBeUndefined()
          }
          const current = yield* waiter.status(old)
          expect(current.executionActive).toBe(live)
          expect(current.executionState).toBe(live ? "running" : "stopped")
          expect(current.turnCount).toBe(old.turnCount + 1)
          expectNoTerminal(current)
        }),
      ),
    )
  }

  for (const initial of ["running", "idle"] as const) {
    it.live(
      `wait starting from ${initial} does not complete while the terminal execution is still finishing`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { entry, waiter, registry, executions, sessions } = yield* statusFixture
          yield* registry.updateStatus(entry.sessionID, entry.actorID, { status: "running" })
          const execution = yield* Effect.acquireRelease(
            executions.reserve(entry.sessionID, entry.actorID),
            executions.release,
          )
          const finish = yield* Deferred.make<void>()
          const terminal = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const fiber = yield* executions.fork(
            execution,
            Effect.gen(function* () {
              yield* Deferred.await(finish)
              yield* terminalDelivery(entry.sessionID, "success")
              yield* Deferred.succeed(terminal, undefined)
              yield* Deferred.await(release)
            }).pipe(
              Effect.provideService(SessionNs.Service, sessions),
              Effect.provideService(ActorRegistry.Service, registry),
              Effect.interruptible,
              Effect.ensuring(executions.release(execution)),
            ),
            yield* Effect.scope,
          )
          if (initial === "idle") {
            yield* Deferred.succeed(finish, undefined)
            yield* Deferred.await(terminal)
          }
          const waiting = yield* waiter
            .wait({ sessionID: entry.sessionID, actor_id: entry.actorID, timeout_ms: 100 })
            .pipe(Effect.forkChild)
          if (initial === "running") {
            yield* Effect.sleep("20 millis")
            yield* Deferred.succeed(finish, undefined)
            yield* Deferred.await(terminal)
          }
          const snapshot = yield* Fiber.join(waiting)
          expect(fiber.pollUnsafe()).toBeUndefined()
          expect(yield* Deferred.isDone(execution.done)).toBe(false)
          expect(snapshot.status).toBe("timeout")
          expect(snapshot.executionActive).toBe(true)
          expect(snapshot.executionState).toBe("running")
          expectNoDelivery(snapshot)
          const finishing = yield* waiter
            .wait({ sessionID: entry.sessionID, actor_id: entry.actorID, timeout_ms: 2000 })
            .pipe(Effect.forkChild)
          yield* Effect.sleep("10 millis")
          expect(finishing.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(fiber)
          const completed = yield* Fiber.join(finishing).pipe(Effect.timeout("500 millis"))
          expect(completed.status).toBe("idle")
          expect(completed.executionState).toBe("completed")
          expect(completed.result).toBe("PREVIOUS-RESULT")
        }),
      ),
    )
  }
})

describe("ActorWaiter — lifecycle predicate (Plan 3 / Task 3)", () => {
  it.live(
    "[TP-R14-11] failure reads the referenced structured delivery rather than newer text",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service
        const waiter = yield* ActorWaiter.Service
        const parent = yield* sessions.create({ title: "structured partial" })
        yield* registry.register({
          sessionID: parent.id,
          actorID: "child",
          mode: "subagent",
          agent: "general",
          description: "child",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* seedAssistantText(parent.id, "child", "raw text")
        const delivery = (yield* sessions.messages({ sessionID: parent.id, agentID: "child" })).findLast(
          (m) => m.info.role === "assistant",
        )!
        if (delivery.info.role !== "assistant") throw new Error("missing assistant")
        yield* sessions.updateMessage({ ...delivery.info, actorResult: { structured: { answer: 42 } } })
        yield* seedAssistantText(parent.id, "child", "UNRELATED-NEWER-TEXT")
        yield* registry.updateStatus(parent.id, "child", {
          status: "idle",
          lastOutcome: "failure",
          lastError: "verification failed",
          resultMessageID: delivery.info.id,
        })
        const snapshot = yield* waiter.wait({ sessionID: parent.id, actor_id: "child" })
        expect(snapshot.lastOutcome).toBe("failure")
        expect(snapshot.structured).toEqual({ answer: 42 })
        expect(snapshot.result).toBeUndefined()
      }),
    ),
  )
  for (const previousOutcome of ["success", "failure"] as const) {
    it.live(
      `[TP-R14-11] failure without output does not reuse a previous ${previousOutcome} delivery`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const registry = yield* ActorRegistry.Service
          const waiter = yield* ActorWaiter.Service
          const parent = yield* sessions.create({ title: "delivery isolation" })
          yield* registry.register({
            sessionID: parent.id,
            actorID: "child",
            mode: "subagent",
            agent: "general",
            description: "child",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* seedAssistantText(parent.id, "child", "OLD-RESULT")
          const message = (yield* sessions.messages({ sessionID: parent.id, agentID: "child" })).findLast(
            (m) => m.info.role === "assistant",
          )!
          if (message.info.role !== "assistant") throw new Error("missing assistant")
          yield* sessions.updateMessage({ ...message.info, actorResult: { finalText: "OLD-RESULT" } })
          yield* registry.updateStatus(parent.id, "child", {
            status: "idle",
            lastOutcome: previousOutcome,
            resultMessageID: message.info.id,
          })
          expect((yield* waiter.wait({ sessionID: parent.id, actor_id: "child" })).result).toBe("OLD-RESULT")
          yield* runTurn(parent.id, "child", Effect.fail("CURRENT-FAILURE")).pipe(Effect.exit)
          const current = yield* waiter.wait({ sessionID: parent.id, actor_id: "child" })
          expect(current.lastOutcome).toBe("failure")
          expect(current.error).toContain("CURRENT-FAILURE")
          expect(current.result).toBeUndefined()
          expect(current.structured).toBeUndefined()
          expect((yield* registry.get(parent.id, "child"))?.resultMessageID).toBeUndefined()
          const prior = (yield* sessions.messages({ sessionID: parent.id, agentID: "child" })).find(
            (m) => m.info.id === message.info.id,
          )!
          if (prior.info.role === "assistant") expect(prior.info.actorResult?.finalText).toBe("OLD-RESULT")
        }),
      ),
    )
  }
  // Test 1: ephemeral idle/success → resolves with result from slice's last assistant
  it.live(
    "ephemeral idle/success resolves with result text from last assistant message",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service
        const waiter = yield* ActorWaiter.Service

        const parent = yield* sessions.create({ title: "parent" })
        yield* registry.register({
          sessionID: parent.id,
          actorID: "explore-1",
          mode: "subagent",
          parentActorID: undefined,
          agent: "explore",
          description: "explore task",
          contextMode: "none",
          contextWatermark: undefined,
          background: false,
          lifecycle: "ephemeral",
        })

        // Seed an assistant message with text "done" in explore-1's slice
        yield* seedAssistantText(parent.id, "explore-1", "done")

        yield* registry.updateStatus(parent.id, "explore-1", { status: "idle", lastOutcome: "success" })

        const snap = yield* waiter.wait({ sessionID: parent.id, actor_id: "explore-1" })

        expect(snap.status).toBe("idle")
        expect(snap.lastOutcome).toBe("success")
        expect(snap.actor_id).toBe("explore-1")
        expect(snap.result).toBe("done")
      }),
    ),
  )

  // Test 2: persistent idle/success → does NOT resolve; times out
  it.live(
    "persistent idle/success does not resolve — wait returns timeout",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service
        const waiter = yield* ActorWaiter.Service

        const parent = yield* sessions.create({ title: "parent" })
        yield* registry.register({
          sessionID: parent.id,
          actorID: "peer-1",
          mode: "peer",
          parentActorID: undefined,
          agent: "general",
          description: "persistent peer",
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "persistent",
        })
        yield* registry.updateStatus(parent.id, "peer-1", { status: "idle", lastOutcome: "success" })

        const snap = yield* waiter.wait({ sessionID: parent.id, actor_id: "peer-1", timeout_ms: 200 })

        expect(snap.status).toBe("timeout")
      }),
    ),
  )

  // Test 3: persistent idle/failure → resolves
  it.live(
    "persistent idle/failure resolves with error in snapshot",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service
        const waiter = yield* ActorWaiter.Service

        const parent = yield* sessions.create({ title: "parent" })
        yield* registry.register({
          sessionID: parent.id,
          actorID: "peer-2",
          mode: "peer",
          parentActorID: undefined,
          agent: "general",
          description: "persistent peer fail",
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "persistent",
        })
        yield* registry.updateStatus(parent.id, "peer-2", {
          status: "idle",
          lastOutcome: "failure",
          lastError: "boom",
        })

        const snap = yield* waiter.wait({ sessionID: parent.id, actor_id: "peer-2" })

        expect(snap.status).toBe("idle")
        expect(snap.lastOutcome).toBe("failure")
        expect(snap.error).toBe("boom")
      }),
    ),
  )

  // Desktop tool-step-schema [TP-R14-11]: a missed event at the timeout
  // boundary must not hide a persisted failure/cancellation.
  for (const lastOutcome of ["failure", "cancelled"] as const) {
    it.live(
      `[TP-R14-11] timeout performs a final registry read for ${lastOutcome}`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const registry = yield* ActorRegistry.Service
          const parent = yield* sessions.create({ title: "timeout boundary" })
          yield* registry.register({
            sessionID: parent.id,
            actorID: "child",
            mode: "peer",
            agent: "general",
            description: "child",
            contextMode: "none",
            background: true,
            lifecycle: "persistent",
          })
          yield* registry.updateStatus(parent.id, "child", { status: "idle", lastOutcome: "success" })
          const subscribed = yield* Deferred.make<void>()
          const result = yield* Effect.gen(function* () {
            const waiter = yield* ActorWaiter.Service
            yield* Effect.forkChild(
              Effect.gen(function* () {
                yield* Deferred.await(subscribed)
                yield* Effect.sleep("5 millis")
                yield* registry.updateStatus(parent.id, "child", {
                  status: "idle",
                  lastOutcome,
                  lastError: lastOutcome === "failure" ? "boom" : undefined,
                })
              }),
            )
            return yield* waiter.wait({ sessionID: parent.id, actor_id: "child", timeout_ms: 30 })
          }).pipe(
            Effect.provide(Layer.fresh(ActorWaiter.layer)),
            Effect.provideService(
              Bus.Service,
              Bus.Service.of({
                ...(yield* Bus.Service),
                subscribeCallback: () => Deferred.succeed(subscribed, undefined).pipe(Effect.as(() => {})),
              }),
            ),
          )
          expect(result.lastOutcome).toBe(lastOutcome)
          expect(result.status).toBe("idle")
          expect(result.error).toBe(lastOutcome === "failure" ? "boom" : undefined)
        }),
      ),
    )
  }

  // Test 4: unknown actor → status: "unknown"
  it.live(
    "unknown actor returns status: unknown",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const waiter = yield* ActorWaiter.Service

        const snap = yield* waiter.wait({
          sessionID: SessionID.make("ses_never_existed"),
          actor_id: "ghost",
        })

        expect(snap.status).toBe("unknown")
        expect(snap.actor_id).toBe("ghost")
      }),
    ),
  )

  for (const lastOutcome of ["success", "failure", "cancelled"] as const) {
    it.live(
      `[TP-R14-11] slow path: status flips during wait, callback resolves with ${lastOutcome}`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const registry = yield* ActorRegistry.Service
          const waiter = yield* ActorWaiter.Service

          const parent = yield* sessions.create({ title: "parent" })
          yield* registry.register({
            sessionID: parent.id,
            actorID: "explore-2",
            mode: "subagent",
            parentActorID: undefined,
            agent: "explore",
            description: "in-flight",
            contextMode: "none",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          })
          yield* registry.updateStatus(parent.id, "explore-2", { status: "running" })
          const executions = yield* ActorExecution.Service
          const execution = yield* executions.reserve(parent.id, "explore-2")

          yield* executions.fork(
            execution,
            Effect.gen(function* () {
              yield* Effect.sleep("50 millis")
              yield* seedAssistantText(parent.id, "explore-2", "result from slow path")
              yield* registry.updateStatus(parent.id, "explore-2", {
                status: "idle",
                lastOutcome,
                lastError: lastOutcome === "failure" ? "execution failed" : undefined,
              })
            }).pipe(
              Effect.provideService(SessionNs.Service, sessions),
              Effect.interruptible,
              Effect.ensuring(executions.release(execution)),
            ),
            yield* Effect.scope,
          )

          const snap = yield* waiter.wait({ sessionID: parent.id, actor_id: "explore-2", timeout_ms: 2000 })

          expect(snap.status).toBe("idle")
          expect(snap.lastOutcome).toBe(lastOutcome)
          yield* executions.release(execution)
          expect(snap.result).toBe(lastOutcome === "success" ? "result from slow path" : undefined)
          expect(snap.error).toBe(lastOutcome === "failure" ? "execution failed" : undefined)
        }),
      ),
    )
  }
})
