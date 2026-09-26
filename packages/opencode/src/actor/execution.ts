import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scheduler, Scope } from "effect"
import type { SessionID } from "@/session/schema"
import { Instance } from "@/project/instance"
import { InstanceState } from "@/effect"
import { Database } from "@/storage"
import { ExecutionOwnership } from "@/session/execution-ownership"

export interface Execution {
  readonly sessionID: SessionID
  readonly actorID: string
  readonly identity: ExecutionOwnership.Identity
  readonly done: Deferred.Deferred<void>
  fiber?: Fiber.Fiber<unknown, unknown>
  cancelled: boolean
  /**
   * Session process-group abort marked THIS execution: terminal notify must
   * not auto-wake parents. Bound to the execution object for its whole life —
   * a later main turn or resume must not clear it for late terminal handlers.
   */
  groupAbort?: boolean
  releaseInstance?: () => void
}

export interface Interface {
  readonly reserve: (sessionID: SessionID, actorID: string, directory?: string) => Effect.Effect<Execution>
  readonly acquire: (sessionID: SessionID, actorID: string) => Effect.Effect<Execution>
  readonly current: (sessionID: SessionID, actorID: string) => Effect.Effect<Execution | undefined>
  readonly currentUnsafe: (sessionID: SessionID, actorID: string) => Execution | undefined
  readonly hasActiveUnsafe: (sessionID: SessionID) => boolean
  readonly attach: (execution: Execution) => Effect.Effect<void>
  readonly fork: (
    execution: Execution,
    work: Effect.Effect<void>,
    scope: Scope.Scope,
    onRejected?: (cause: Cause.Cause<never>) => Effect.Effect<void>,
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
    const reserve = Effect.fn("ActorExecution.reserve")(function* (sessionID: SessionID, actorID: string, directory?: string) {
      const identity = yield* ExecutionOwnership.captureIdentity
      const done = yield* Deferred.make<void>()
      const dir = directory ?? (yield* InstanceState.directory)
      return yield* Effect.sync(() => {
        Database.use((db) => ExecutionOwnership.assertOwnership(db, sessionID, identity))
        const id = key(sessionID, actorID)
        if (active.has(id)) throw new Error(`Actor execution already active: ${id}`)
        const releaseInstance = Instance.claim(dir)
        const execution: Execution = { sessionID, actorID, identity, done, cancelled: false, releaseInstance }
        active.set(id, execution)
        return execution
      })
    })
    const release = (execution: Execution) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          const id = key(execution.sessionID, execution.actorID)
          if (active.get(id) === execution) {
            active.delete(id)
            execution.releaseInstance?.()
          }
        })
        yield* Deferred.succeed(execution.done, undefined)
      }).pipe(Effect.asVoid, Effect.uninterruptible)
    const checkOwnership = (execution: Execution, onRejected?: (cause: Cause.Cause<never>) => Effect.Effect<void>) =>
      Effect.sync(() => Database.use((db) =>
        ExecutionOwnership.assertOwnership(db, execution.sessionID, execution.identity),
      )).pipe(Effect.onExit((exit) => Exit.isFailure(exit)
        ? Effect.suspend(() => onRejected ? onRejected(exit.cause) : Effect.void).pipe(Effect.ensuring(release(execution)))
        : Effect.void))
    return Service.of({
      reserve,
      acquire: (sessionID, actorID) =>
        Effect.gen(function* () {
          const identity = yield* ExecutionOwnership.captureIdentity
          const directory = yield* InstanceState.directory
          const releaseInstance = yield* Effect.sync(() => Instance.claim(directory))
          let transferred = false
          return yield* Effect.gen(function* () {
            for (;;) {
              const claim = yield* Effect.sync(() => {
                Database.use((db) => ExecutionOwnership.assertOwnership(db, sessionID, identity))
                const id = key(sessionID, actorID)
                const existing = active.get(id)
                if (existing) return { owned: false, execution: existing }
                const execution: Execution = { sessionID, actorID, identity, done: Deferred.makeUnsafe<void>(), cancelled: false, releaseInstance }
                active.set(id, execution)
                transferred = true
                return { owned: true, execution }
              })
              if (claim.owned) return claim.execution
              yield* Deferred.await(claim.execution.done).pipe(Effect.interruptible)
            }
          }).pipe(Effect.ensuring(Effect.sync(() => { if (!transferred) releaseInstance() })))
        }),
      current,
      currentUnsafe: (sessionID, actorID) => active.get(key(sessionID, actorID)),
      hasActiveUnsafe: (sessionID) => [...active.values()].some((execution) => execution.sessionID === sessionID),
      attach: (execution) =>
        Effect.withFiber((fiber) => checkOwnership(execution).pipe(
          Effect.andThen(Effect.sync(() => {
            execution.fiber = fiber
          })),
        )),
      fork: (execution, work, scope, onRejected) =>
        Effect.gen(function* () {
          const preventYield = yield* Scheduler.PreventSchedulerYield
          return yield* Effect.gen(function* () {
            const fiber = yield* checkOwnership(execution, onRejected).pipe(
              Effect.andThen(work),
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
