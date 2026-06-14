import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Ref, Scope } from "effect"
import { Runner } from "../../src/effect"
import { it } from "../lib/effect"

describe("Runner onReentryWarn", () => {
  it.live(
    "fires onReentryWarn with label and run ID on Running re-entry",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const warnings = yield* Ref.make<Array<{ label: string; existingRunId: number }>>([])
      const runner = Runner.make<string>(s, {
        label: "test-runner",
        onReentryWarn: (info) => Ref.update(warnings, (arr) => [...arr, info]),
      })

      const work = Effect.gen(function* () {
        yield* Effect.sleep("50 millis")
        return "result"
      })

      const [a, b] = yield* Effect.all([runner.ensureRunning(work), runner.ensureRunning(Effect.succeed("ignored"))], {
        concurrency: "unbounded",
      })

      expect(a).toBe("result")
      expect(b).toBe("result")

      const logged = yield* Ref.get(warnings)
      expect(logged.length).toBe(1)
      expect(logged[0].label).toBe("test-runner")
      expect(logged[0].existingRunId).toBe(1)
    }),
  )

  it.live(
    "uses (unlabeled) when no label is provided",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const warnings = yield* Ref.make<Array<{ label: string; existingRunId: number }>>([])
      const runner = Runner.make<string>(s, {
        onReentryWarn: (info) => Ref.update(warnings, (arr) => [...arr, info]),
      })

      const work = Effect.gen(function* () {
        yield* Effect.sleep("50 millis")
        return "result"
      })

      yield* Effect.all([runner.ensureRunning(work), runner.ensureRunning(Effect.succeed("ignored"))], {
        concurrency: "unbounded",
      })

      const logged = yield* Ref.get(warnings)
      expect(logged.length).toBe(1)
      expect(logged[0].label).toBe("(unlabeled)")
    }),
  )

  it.live(
    "does not fire onReentryWarn when runner is idle",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const warnings = yield* Ref.make<Array<{ label: string; existingRunId: number }>>([])
      const runner = Runner.make<string>(s, {
        label: "idle-test",
        onReentryWarn: (info) => Ref.update(warnings, (arr) => [...arr, info]),
      })

      yield* runner.ensureRunning(Effect.succeed("first"))
      yield* runner.ensureRunning(Effect.succeed("second"))

      const logged = yield* Ref.get(warnings)
      expect(logged.length).toBe(0)
    }),
  )

  it.live(
    "fires onReentryWarn on ShellThenRun re-entry",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const warnings = yield* Ref.make<Array<{ label: string; existingRunId: number }>>([])
      const runner = Runner.make<string>(s, {
        label: "shell-reentry",
        onReentryWarn: (info) => Ref.update(warnings, (arr) => [...arr, info]),
      })

      const gate = yield* Deferred.make<void>()
      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* Effect.sleep("10 millis")

      // First ensureRunning transitions to ShellThenRun
      const run1 = yield* runner.ensureRunning(Effect.succeed("run1")).pipe(Effect.forkChild)
      yield* Effect.sleep("10 millis")
      expect(runner.state._tag).toBe("ShellThenRun")

      // Second ensureRunning hits re-entry on ShellThenRun
      const run2 = yield* runner.ensureRunning(Effect.succeed("run2")).pipe(Effect.forkChild)
      yield* Effect.sleep("10 millis")

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)
      yield* Fiber.await(run1)
      yield* Fiber.await(run2)

      const logged = yield* Ref.get(warnings)
      expect(logged.length).toBe(1)
      expect(logged[0].label).toBe("shell-reentry")
    }),
  )
})
