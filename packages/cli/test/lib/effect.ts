import { afterEach, test, type TestOptions } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import type * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { Log } from "../../src/util"

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value))
const running = new Map<Fiber.Fiber<unknown, unknown>, () => void>()

// The log queue is process-wide: work leaked by earlier files can back it up for
// minutes on slow CI disks. Flushing here is best-effort; tests that assert on
// log contents call Log.flush() themselves.
const FLUSH_BUDGET_MS = 1_000
const flushLogs = () => Promise.race([Log.flush(), Bun.sleep(FLUSH_BUDGET_MS)])

afterEach(async () => {
  await Promise.all(
    [...running].map(([fiber, cancel]) => {
      cancel()
      return Effect.runPromise(Fiber.interrupt(fiber))
    }),
  )
  await flushLogs()
})

const run = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) => {
  const fiber = Effect.gen(function* () {
    const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(layer), Effect.exit)
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err)
      }
    }
    return yield* exit
  }).pipe(Effect.ensuring(Effect.promise(flushLogs)), Effect.runFork)
  fiber.addObserver(() => running.delete(fiber))
  return new Promise<A>((resolve, reject) => {
    const cancel = fiber.addObserver((exit) => {
      if (Exit.isSuccess(exit)) resolve(exit.value)
      else reject(Cause.squash(exit.cause))
    })
    if (!fiber.pollUnsafe()) running.set(fiber, cancel)
  })
}

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>) => {
  const effect = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, testLayer), opts)

  effect.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, testLayer), opts)

  effect.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, testLayer), opts)

  const live = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, liveLayer), opts)

  live.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, liveLayer), opts)

  live.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, liveLayer), opts)

  return { effect, live }
}

// Test environment with TestClock and TestConsole
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())

// Live environment - uses real clock, but keeps TestConsole for output capture
const liveEnv = TestConsole.layer

export const it = make(testEnv, liveEnv)

export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv))
