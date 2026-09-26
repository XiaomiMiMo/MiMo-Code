import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session as SessionNs } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { ActorExecution } from "../../src/actor/execution"
import { TurnQueue, turnQueueRef } from "../../src/turn-queue"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Bus.layer,
  ActorRegistry.defaultLayer,
  TurnQueue.defaultLayer,
  ActorWaiter.layer.pipe(
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionNs.defaultLayer),
  ),
)

const it = testEffect(env)

describe("turn-queue + actor wait steer", () => {
  it.live(
    "user admit on main lane interrupts a blocking wait without cancelling the actor",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const registry = yield* ActorRegistry.Service
        const waiter = yield* ActorWaiter.Service
        const tq = yield* TurnQueue.Service

        const parent = yield* sessions.create({ title: "steer-wait" })
        yield* registry.register({
          sessionID: parent.id,
          actorID: "explore-9",
          mode: "subagent",
          agent: "explore",
          description: "long",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        const executions = yield* ActorExecution.Service
        const execution = yield* Effect.acquireRelease(executions.reserve(parent.id, "explore-9"), executions.release)
        const actorFiber = yield* executions.fork(
          execution,
          Effect.never.pipe(Effect.interruptible, Effect.ensuring(executions.release(execution))),
          yield* Effect.scope,
        )
        yield* registry.updateStatus(parent.id, "explore-9", { status: "running" })

        const waitFiber = yield* waiter
          .wait({ sessionID: parent.id, actor_id: "explore-9", timeout_ms: 5000 })
          .pipe(Effect.forkChild)
        yield* Effect.sleep("30 millis")
        yield* tq.admit({
          lane: { sessionID: parent.id, agentID: "main" },
          intent: { kind: "prompt", messageID: MessageID.ascending() },
        })
        const snap = yield* Fiber.join(waitFiber)
        expect(snap.status).toBe("interrupted")
        expect(snap.actor_id).toBe("explore-9")
        expect((yield* registry.get(parent.id, "explore-9"))?.status).toBe("running")
        expect(yield* executions.current(parent.id, "explore-9")).toBe(execution)
        expect(execution.cancelled).toBe(false)
        expect(yield* Deferred.isDone(execution.done)).toBe(false)
        yield* Fiber.interrupt(actorFiber)
        expect(yield* executions.current(parent.id, "explore-9")).toBeUndefined()
      }),
    ),
  )

  for (const outcome of ["success", "timeout"] as const) {
    it.live(
      `repeated waits clean up input observers after ${outcome}`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const registry = yield* ActorRegistry.Service
          const executions = yield* ActorExecution.Service
          const waiter = yield* ActorWaiter.Service
          const tq = yield* TurnQueue.Service
          const parent = yield* sessions.create({ title: "wait observer cleanup" })
          let active = 0
          let started = 0
          let observing = Deferred.makeUnsafe<void>()
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = turnQueueRef.current
              turnQueueRef.current = {
                ...tq,
                observeInput: (lane, revision) =>
                  revision < 0
                    ? tq.observeInput(lane, revision)
                    : Effect.acquireUseRelease(
                        Effect.sync(() => {
                          active++
                          started++
                          Deferred.doneUnsafe(observing, Effect.void)
                        }),
                        () => tq.observeInput(lane, revision),
                        () =>
                          Effect.sync(() => {
                            active--
                          }),
                      ),
              }
              return previous
            }),
            (previous) =>
              Effect.sync(() => {
                turnQueueRef.current = previous
              }),
          )

          for (let i = 0; i < 3; i++) {
            observing = Deferred.makeUnsafe<void>()
            const actorID = `child-${i}`
            yield* registry.register({
              sessionID: parent.id,
              actorID,
              mode: "subagent",
              agent: "general",
              description: "observer cleanup",
              contextMode: "none",
              background: true,
              lifecycle: "ephemeral",
            })
            const execution = yield* Effect.acquireRelease(executions.reserve(parent.id, actorID), executions.release)
            yield* registry.updateStatus(parent.id, actorID, { status: "running" })
            const finish = yield* Deferred.make<void>()
            const actorFiber = yield* executions.fork(
              execution,
              Effect.gen(function* () {
                yield* Deferred.await(observing)
                if (outcome === "timeout") yield* Deferred.await(finish)
                yield* registry.updateStatus(parent.id, actorID, { status: "idle", lastOutcome: "success" })
              }).pipe(Effect.interruptible, Effect.ensuring(executions.release(execution))),
              yield* Effect.scope,
            )

            // Keep waits in the same parent fiber so parent shutdown cannot hide leaked observers.
            const result = yield* waiter.wait({ sessionID: parent.id, actor_id: actorID, timeout_ms: 100 })
            expect(result.status).toBe(outcome === "success" ? "idle" : "timeout")
            expect(started).toBe(i + 1)
            expect(active).toBe(0)
            yield* Deferred.succeed(finish, undefined)
            yield* Fiber.join(actorFiber)
            expect(yield* executions.current(parent.id, actorID)).toBeUndefined()
          }
        }),
      ),
    )
  }

  it.live(
    "prompt intent settles to success after ack with MessageID frontier",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const tq = yield* TurnQueue.Service
        const parent = yield* sessions.create({ title: "settle" })
        const lane = { sessionID: parent.id, agentID: "main" }
        const mid = MessageID.ascending()
        const r = yield* tq.admit({ lane, intent: { kind: "prompt", messageID: mid } })
        const claim = yield* tq.claimNext(lane, 42)
        expect(claim?.claimFrontier).toBe(mid)
        yield* tq.ack(lane, mid, [{ receiptId: r.id, outcome: "success", messageId: MessageID.ascending() }])
        const after = yield* tq.getReceipt(r.id)
        expect(after.state).toBe("settled")
        expect(after.outcome).toBe("success")
        expect(after.runId).toBe(42)
      }),
    ),
  )
})
