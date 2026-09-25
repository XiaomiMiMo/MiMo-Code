import { Context, Deferred, Effect, Fiber, Layer, Scheduler, Scope } from "effect"
import type { SessionID } from "@/session/schema"
import { SessionRuntime, type RuntimeProjection } from "@/session/runtime"
import * as ExecutionState from "./execution-state"

const owners = new WeakMap<Execution, { active: Map<string, Execution>; runtime: RuntimeProjection }>()

export interface Execution {
  readonly sessionID: SessionID
  readonly actorID: string
  readonly done: Deferred.Deferred<void>
  fiber?: Fiber.Fiber<unknown, unknown>
  cancelled: boolean
  /**
   * Session process-group abort marked THIS execution: terminal notify must
   * not auto-wake parents. Bound to the execution object for its whole life —
   * a later main turn or resume must not clear it for late terminal handlers.
   */
  groupAbort?: boolean
}

export interface Interface {
  readonly reserve: (sessionID: SessionID, actorID: string) => Effect.Effect<Execution>
  readonly acquire: (sessionID: SessionID, actorID: string) => Effect.Effect<Execution>
  readonly current: (sessionID: SessionID, actorID: string) => Effect.Effect<Execution | undefined>
  readonly attach: (execution: Execution) => Effect.Effect<void>
  readonly fork: (
    execution: Execution,
    work: Effect.Effect<void>,
    scope: Scope.Scope,
  ) => Effect.Effect<Fiber.Fiber<void>>
  readonly release: (execution: Execution) => Effect.Effect<void>
  readonly requestCancel: (execution: Execution) => Effect.Effect<void>
  readonly interrupt: (execution: Execution) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ActorExecution") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const key = (sessionID: SessionID, actorID: string) => `${sessionID}:${actorID}`
    const current = (sessionID: SessionID, actorID: string) => Effect.sync(() => ExecutionState.current().get(key(sessionID, actorID)))
    const claim = (execution: Execution, active: Map<string, Execution>) => {
      const runtime = SessionRuntime.current()
      active.set(key(execution.sessionID, execution.actorID), execution)
      owners.set(execution, { active, runtime })
      runtime.refreshExecution(execution.sessionID, execution.actorID)
      return execution
    }
    const reserve = Effect.fn("ActorExecution.reserve")(function* (sessionID: SessionID, actorID: string) {
      const done = yield* Deferred.make<void>()
      return yield* Effect.sync(() => {
        const active = ExecutionState.current()
        const id = key(sessionID, actorID)
        if (active.has(id)) throw new Error(`Actor execution already active: ${id}`)
        return claim({ sessionID, actorID, done, cancelled: false }, active)
      })
    })
    const release = (execution: Execution) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          const owner = owners.get(execution)
          const id = key(execution.sessionID, execution.actorID)
          if (owner?.active.get(id) !== execution) return
          owner.active.delete(id)
          owners.delete(execution)
          owner.runtime.refreshExecution(execution.sessionID, execution.actorID)
        })
        yield* Deferred.succeed(execution.done, undefined)
      }).pipe(Effect.asVoid, Effect.uninterruptible)
    return Service.of({
      reserve,
      acquire: (sessionID, actorID) =>
        Effect.gen(function* () {
          for (;;) {
            const next = yield* Effect.sync(() => {
              const active = ExecutionState.current()
              const existing = active.get(key(sessionID, actorID))
              if (existing) return { owned: false, execution: existing }
              return { owned: true, execution: claim({ sessionID, actorID, done: Deferred.makeUnsafe<void>(), cancelled: false }, active) }
            })
            if (next.owned) return next.execution
            yield* Deferred.await(next.execution.done).pipe(Effect.interruptible)
          }
        }),
      current,
      attach: (execution) =>
        Effect.withFiber((fiber) =>
          Effect.sync(() => {
            execution.fiber = fiber
          }),
        ),
      fork: (execution, work, scope) =>
        Effect.gen(function* () {
          const preventYield = yield* Scheduler.PreventSchedulerYield
          return yield* Effect.gen(function* () {
            const fiber = yield* work.pipe(
              Effect.provideService(Scheduler.PreventSchedulerYield, preventYield),
              Effect.forkIn(scope, { uninterruptible: true }),
            )
            execution.fiber = fiber
            return fiber
          }).pipe(
            // Fork and handle publication must not admit a scheduler turn between them.
            Effect.provideService(Scheduler.PreventSchedulerYield, true),
            Effect.uninterruptible,
          )
        }),
      release,
      requestCancel: (execution) =>
        Effect.sync(() => {
          execution.cancelled = true
        }),
      interrupt: (execution) =>
        Effect.gen(function* () {
          if (execution.fiber) yield* Fiber.interrupt(execution.fiber)
          yield* Deferred.await(execution.done)
        }),
    })
  }),
)

export * as ActorExecution from "./execution"
