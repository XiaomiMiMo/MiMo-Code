import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import { Runner } from "../../src/effect"
import { it } from "../lib/effect"

describe("SessionRunState tuple key — independent Runners per (sid, agentID)", () => {
  it.live(
    "main + subagent Runners run concurrently without deadlock",
    Effect.gen(function* () {
      const s = yield* Scope.Scope

      // Simulate the tuple-key Map: main and explore-1 each get their own Runner
      const mainRunner = Runner.make<string>(s, { label: "session-1:main" })
      const subRunner = Runner.make<string>(s, { label: "session-1:explore-1" })

      // Main runner starts work that internally uses the subagent runner
      const result = yield* mainRunner.ensureRunning(
        Effect.gen(function* () {
          // Inside main work, the subagent runner starts its own work concurrently
          const subResult = yield* subRunner.ensureRunning(Effect.succeed("sub-done"))
          return `main-done:${subResult}`
        }),
      )

      expect(result).toBe("main-done:sub-done")
      expect(mainRunner.busy).toBe(false)
      expect(subRunner.busy).toBe(false)
    }),
  )

  it.live(
    "single-key Runner reentry shares deferred (proves tuple-key is necessary)",
    Effect.gen(function* () {
      const s = yield* Scope.Scope

      // With a single Runner (old behavior), inner ensureRunning attaches to
      // the same deferred — it returns the outer result, not its own work.
      const sharedRunner = Runner.make<string>(s, { label: "shared" })

      const fiber = yield* sharedRunner
        .ensureRunning(
          Effect.gen(function* () {
            // This inner ensureRunning attaches to the OUTER run's deferred (reentry)
            const inner = yield* sharedRunner.ensureRunning(Effect.succeed("inner-value"))
            return `outer:${inner}`
          }),
        )
        .pipe(Effect.timeout("500 millis"), Effect.forkChild)

      const exit = yield* Fiber.await(fiber)
      // With shared runner, the inner call shares the outer deferred, so it
      // never resolves independently — the fiber times out or produces a
      // recursive result. Either way it's NOT "outer:inner-value".
      if (Exit.isSuccess(exit) && exit.value !== undefined) {
        expect(exit.value).not.toBe("outer:inner-value")
      }
    }),
  )

  it.live(
    "cancelActor pattern: cancelling subagent does not affect main",
    Effect.gen(function* () {
      const s = yield* Scope.Scope

      const mainRunner = Runner.make<string>(s, {
        label: "session-1:main",
        onInterrupt: Effect.succeed("main-interrupted"),
      })
      const subRunner = Runner.make<string>(s, {
        label: "session-1:explore-1",
        onInterrupt: Effect.succeed("sub-interrupted"),
      })

      // Start main with long work
      const mainFiber = yield* mainRunner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Effect.sleep("200 millis")
            return "main-complete"
          }),
        )
        .pipe(Effect.forkChild)

      // Start sub with long work
      const subFiber = yield* subRunner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Effect.sleep("10 seconds")
            return "sub-complete"
          }),
        )
        .pipe(Effect.forkChild)

      // Let both start
      yield* Effect.sleep("10 millis")

      // Cancel only the subagent
      yield* subRunner.cancel

      const subExit = yield* Fiber.await(subFiber)
      expect(Exit.isSuccess(subExit)).toBe(true)
      if (Exit.isSuccess(subExit)) expect(subExit.value).toBe("sub-interrupted")

      // Main should complete normally
      const mainExit = yield* Fiber.await(mainFiber)
      expect(Exit.isSuccess(mainExit)).toBe(true)
      if (Exit.isSuccess(mainExit)) expect(mainExit.value).toBe("main-complete")
    }),
    5000,
  )

  it.live(
    "onReentryWarn fires when reentry detected on same Runner",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const warnings: Array<{ label: string; existingRunId: number }> = []

      const runner = Runner.make<string>(s, {
        label: "session-1:main",
        onReentryWarn: (info) =>
          Effect.sync(() => {
            warnings.push(info)
          }),
      })

      // Start first run
      const fiber1 = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Effect.sleep("50 millis")
            return "first"
          }),
        )
        .pipe(Effect.forkChild)

      // Give first run time to start
      yield* Effect.sleep("5 millis")

      // Second call triggers reentry warn
      const fiber2 = yield* runner.ensureRunning(Effect.succeed("second")).pipe(Effect.forkChild)

      const [exit1, exit2] = yield* Effect.all([Fiber.await(fiber1), Fiber.await(fiber2)])
      // Both get the first run's result (reentry attaches to existing deferred)
      expect(Exit.isSuccess(exit1)).toBe(true)
      expect(Exit.isSuccess(exit2)).toBe(true)
      if (Exit.isSuccess(exit1)) expect(exit1.value).toBe("first")
      if (Exit.isSuccess(exit2)) expect(exit2.value).toBe("first")
      expect(warnings.length).toBe(1)
      expect(warnings[0].label).toBe("session-1:main")
    }),
  )
})
