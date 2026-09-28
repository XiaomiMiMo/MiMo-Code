import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { Runner } from "../../src/effect"
import { it } from "../lib/effect"

describe("Runner acquisition guard", () => {
  for (const entry of ["start", "startOwned", "ensureExclusive", "ensureRunning", "startShell"] as const) {
    it.live(`${entry} rejects before consuming a run ID or invoking work`, Effect.gen(function* () {
      const runner = Runner.make<void>(yield* Scope.Scope)
      let ran = false
      const denied = yield* runner[entry](Effect.sync(() => { ran = true }), Effect.die(new Error("revoked"))).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      expect(ran).toBe(false)
      expect(runner.busy).toBe(false)
      const next = yield* runner.startOwned(Effect.never)
      expect(next.runId).toBe(1)
      yield* next.interruptOwned
    }), 30000)
  }

  for (const waitingOn of ["run", "shell", "cancelling"] as const) {
    it.live(`revalidates a delayed waiter after ${waitingOn} without creating a lease`, Effect.gen(function* () {
      const runner = Runner.make<void>(yield* Scope.Scope, { onInterrupt: Effect.void })
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const exiting = yield* Deferred.make<void>()
      const releaseFinalizer = yield* Deferred.make<void>()
      const work = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish)))
      const first = yield* (waitingOn === "shell" ? runner.startShell(work) : runner.ensureRunning(work.pipe(
        Effect.ensuring(Deferred.succeed(exiting, undefined).pipe(Effect.andThen(Deferred.await(releaseFinalizer)))),
      ))).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const cancel = waitingOn === "cancelling" ? yield* runner.cancel.pipe(Effect.forkChild) : undefined
      if (cancel) yield* Deferred.await(exiting)
      const checked = yield* Deferred.make<void>()
      let revoked = false
      let checks = 0
      let ran = false
      const guard = Effect.sync(() => {
        checks++
        if (revoked) throw new Error("revoked")
        Deferred.doneUnsafe(checked, Effect.void)
      })
      const delayed = yield* runner.ensureRunning(Effect.sync(() => { ran = true }), guard).pipe(Effect.forkChild)
      yield* Deferred.await(checked)
      yield* Effect.yieldNow
      revoked = true
      yield* Deferred.succeed(finish, undefined)
      yield* Deferred.succeed(releaseFinalizer, undefined)
      if (cancel) yield* Fiber.await(cancel)
      yield* Fiber.await(first)
      expect(Exit.isFailure(yield* Fiber.await(delayed))).toBe(true)
      expect(checks).toBe(2)
      expect(ran).toBe(false)
      const next = yield* runner.startOwned(Effect.never)
      expect(next.runId).toBe(2)
      yield* next.interruptOwned
    }), 30000)
  }
})
