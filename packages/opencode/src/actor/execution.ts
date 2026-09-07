import { Context, Deferred, Effect, Fiber, Layer, Scheduler, Scope } from "effect"
import type { SessionID } from "@/session/schema"

export interface Execution {
  readonly sessionID: SessionID
  readonly actorID: string
  readonly done: Deferred.Deferred<void>
  fiber?: Fiber.Fiber<unknown, unknown>
  cancelled: boolean
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
    const active = new Map<string, Execution>()
    const key = (sessionID: SessionID, actorID: string) => `${sessionID}:${actorID}`
    const current = (sessionID: SessionID, actorID: string) => Effect.sync(() => active.get(key(sessionID, actorID)))
    const reserve = Effect.fn("ActorExecution.reserve")(function* (sessionID: SessionID, actorID: string) {
      const done = yield* Deferred.make<void>()
      return yield* Effect.sync(() => {
        const id = key(sessionID, actorID)
        if (active.has(id)) throw new Error(`Actor execution already active: ${id}`)
        const execution: Execution = { sessionID, actorID, done, cancelled: false }
        active.set(id, execution)
        return execution
      })
    })
    const release = (execution: Execution) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          const id = key(execution.sessionID, execution.actorID)
          if (active.get(id) === execution) active.delete(id)
        })
        yield* Deferred.succeed(execution.done, undefined)
      }).pipe(Effect.asVoid, Effect.uninterruptible)
    return Service.of({
      reserve,
      acquire: (sessionID, actorID) =>
        Effect.gen(function* () {
          for (;;) {
            const claim = yield* Effect.sync(() => {
              const id = key(sessionID, actorID)
              const existing = active.get(id)
              if (existing) return { owned: false, execution: existing }
              const execution: Execution = { sessionID, actorID, done: Deferred.makeUnsafe<void>(), cancelled: false }
              active.set(id, execution)
              return { owned: true, execution }
            })
            if (claim.owned) return claim.execution
            yield* Deferred.await(claim.execution.done).pipe(Effect.interruptible)
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
