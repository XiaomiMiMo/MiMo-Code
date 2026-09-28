import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { Runner } from "../../src/effect"
import { it } from "../lib/effect"

// [stale-runner-reclaim] 发消息必须拉起 loop:
// 1) live fiber reentry 等当前执行释放后独占起跑(不丢收尾窗口的新 work)
// 2) fiber 已退出后 ensureRunning 起新 work
// 3) 自然完成后的下一笔是新 run
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
    "live fiber reentry waits for release then starts its work (no lost wake)",
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

      // Reentry retains its work while waiting for the current lease.
      const reentry = yield* runner
        .ensureRunning(Effect.succeed("pending-work"))
        .pipe(Effect.forkChild)
      for (let i = 0; i < 50 && warnings.length === 0; i++) yield* Effect.sleep("5 millis")
      expect(warnings.length).toBe(1)
      // Still a single loop — no second fiber started yet.
      expect(runner.busy).toBe(true)

      // Releasing the old run allows the waiting caller to acquire the lease.
      yield* Deferred.succeed(gate, "live-result")
      const [exit1, exit2] = yield* Effect.all([Fiber.await(fiber), Fiber.await(reentry)])
      expect(Exit.isSuccess(exit1) && exit1.value).toBe("live-result")
      expect(Exit.isSuccess(exit2) && exit2.value).toBe("pending-work")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "lost-wake: work attached after last check still runs when old loop exits",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { label: "ses_lost_wake:main" })
      const lastCheck = yield* Deferred.make<void>()
      const allowExit = yield* Deferred.make<void>()
      const processed: string[] = []

      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            // Simulate: loop finished its last DB message check, then yields
            // before returning (tail work / onExit). New work may arrive here.
            yield* Deferred.succeed(lastCheck, undefined)
            yield* Deferred.await(allowExit)
            return "old-loop"
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(lastCheck)

      // Message written + ensureRunning while old fiber is still live.
      const follow = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            processed.push("follow-up")
            return "follow-up"
          }),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.succeed(allowExit, undefined)
      const [exitOld, exitFollow] = yield* Effect.all([Fiber.await(fiber), Fiber.await(follow)])
      expect(Exit.isSuccess(exitOld) && exitOld.value).toBe("old-loop")
      expect(Exit.isSuccess(exitFollow) && exitFollow.value).toBe("follow-up")
      expect(processed).toEqual(["follow-up"])
      expect(runner.busy).toBe(false)
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

  it.live(
    "concurrent callers execute separately in order without sharing a pending result",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { label: "ses_multi:main" })
      const gate = yield* Deferred.make<string>()
      const aStarted = yield* Deferred.make<void>()
      const aRelease = yield* Deferred.make<void>()
      const executed: string[] = []
      const fiber = yield* runner.ensureRunning(Deferred.await(gate)).pipe(Effect.forkChild)
      const a = yield* runner.ensureRunning(Effect.gen(function* () {
        executed.push("A")
        yield* Deferred.succeed(aStarted, undefined)
        yield* Deferred.await(aRelease)
        return "A"
      })).pipe(Effect.forkChild)
      const b = yield* runner.ensureRunning(Effect.sync(() => {
        executed.push("B")
        return "B"
      })).pipe(Effect.forkChild)

      yield* Deferred.succeed(gate, "live")
      yield* Deferred.await(aStarted)
      expect(executed).toEqual(["A"])
      expect(runner.busy).toBe(true)
      yield* Deferred.succeed(aRelease, undefined)
      const [ex0, exA, exB] = yield* Effect.all([Fiber.await(fiber), Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(ex0) && ex0.value).toBe("live")
      expect(Exit.isSuccess(exA) && exA.value).toBe("A")
      expect(Exit.isSuccess(exB) && exB.value).toBe("B")
      expect(executed).toEqual(["A", "B"])
      expect(runner.busy).toBe(false)
    }),
  )
})
