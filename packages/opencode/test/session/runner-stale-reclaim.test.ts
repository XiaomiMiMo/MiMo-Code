import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { Runner } from "../../src/effect"
import { it } from "../lib/effect"

// [stale-runner-reclaim] 发消息必须拉起 loop：live fiber reentry；fiber 已退出后 ensureRunning 起新 work。
// Stale Running（fiber 死、账本未 Idle）是 finishRun 竞态的防御分支——公共 API 下 finishRun 会先同步
// Idle，故这里用「先 cancel 再 ensureRunning」验证收口后的起跑，并单独钉 live reentry。
describe("Runner.ensureRunning stale reclaim", () => {
  it.live(
    "after cancel (Idle) ensureRunning starts new work",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { label: "ses_after_cancel:main" })
      const started = yield* Deferred.make<void>()
      const never = yield* Deferred.make<string>()
      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Deferred.await(never)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(runner.busy).toBe(true)
      yield* runner.cancel
      expect(runner.busy).toBe(false)
      yield* Fiber.await(fiber)
      const next = yield* runner.ensureRunning(Effect.succeed("after-cancel"))
      expect(next).toBe("after-cancel")
    }),
  )

  it.live(
    "live fiber still reentry-joins (does not start a second loop)",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const warnings: Array<{ existingRunId: number }> = []
      const runner = Runner.make<string>(s, {
        label: "ses_live:main",
        onReentryWarn: (info) =>
          Effect.sync(() => {
            warnings.push(info)
          }),
      })
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<string>()
      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Deferred.await(gate)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const reentry = yield* runner
        .ensureRunning(Effect.succeed("ignored-new-work"))
        .pipe(Effect.forkChild)
      for (let i = 0; i < 50 && warnings.length === 0; i++) yield* Effect.sleep("5 millis")
      expect(warnings.length).toBe(1)
      yield* Deferred.succeed(gate, "live-result")
      const [exit1, exit2] = yield* Effect.all([Fiber.await(fiber), Fiber.await(reentry)])
      expect(Exit.isSuccess(exit1) && exit1.value).toBe("live-result")
      expect(Exit.isSuccess(exit2) && exit2.value).toBe("live-result")
    }),
  )

  it.live(
    "second ensureRunning after natural completion runs new work (not reentry)",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { label: "ses_seq:main" })
      expect(yield* runner.ensureRunning(Effect.succeed("first"))).toBe("first")
      expect(yield* runner.ensureRunning(Effect.succeed("second"))).toBe("second")
      expect(runner.busy).toBe(false)
    }),
  )
})
