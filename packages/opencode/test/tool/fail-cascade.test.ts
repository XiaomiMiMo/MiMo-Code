import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { ToolGate } from "../../src/tool/gate"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const cancelled = "Tool call cancelled because an earlier tool call in this response failed."

it.live("a failed exclusive call cancels queued and late calls before admission", () =>
  Effect.gen(function* () {
    const gate = new ToolGate()
    const started = yield* Deferred.make<void>()
    const fail = yield* Deferred.make<void>()
    const effects: string[] = []
    const first = yield* gate
      .run(
        "edit",
        "first",
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(fail)
          return yield* Effect.fail(new Error("edit failed"))
        }),
      )
      .pipe(Effect.flip, Effect.forkChild)
    yield* Deferred.await(started)
    const second = yield* gate
      .run(
        "bash",
        "second",
        Effect.sync(() => effects.push("push")),
      )
      .pipe(Effect.exit, Effect.forkChild)
    const third = yield* gate
      .run(
        "read",
        "third",
        Effect.sync(() => effects.push("read")),
      )
      .pipe(Effect.exit, Effect.forkChild)
    yield* Effect.yieldNow
    expect(gate.queuedCount).toBe(2)
    yield* Deferred.succeed(fail, undefined)
    expect((yield* Fiber.join(first)).message).toBe("edit failed")
    expect((yield* Fiber.join(second))._tag).toBe("Failure")
    expect((yield* Fiber.join(third))._tag).toBe("Failure")
    expect(effects).toEqual([])
    expect(gate.queuedCount).toBe(0)
    expect(gate.runningCount).toBe(0)
    const late = yield* gate
      .run(
        "write",
        "late",
        Effect.sync(() => effects.push("late")),
      )
      .pipe(Effect.flip)
    expect(late.message).toBe(cancelled)
    expect(effects).toEqual([])
    expect(yield* new ToolGate().run("write", "independent", Effect.succeed("ok"))).toBe("ok")
  }),
)

for (const name of ["read", "grep", "glob"]) {
  it.live(`${name} failure leaves subsequent tools runnable`, () =>
    Effect.gen(function* () {
      const gate = new ToolGate()
      yield* gate.run(name, "first", Effect.fail(new Error("search failed"))).pipe(Effect.exit)
      expect(yield* gate.run("bash", "second", Effect.succeed("executed"))).toBe("executed")
    }),
  )
}

it.live("an exclusive cleanup failure cascades before the next body starts", () =>
  Effect.gen(function* () {
    const gate = new ToolGate()
    yield* gate
      .run("write", "first", Effect.succeed("written").pipe(Effect.ensuring(Effect.die(new Error("cleanup failed")))))
      .pipe(Effect.exit)
    const next = yield* gate.run("bash", "second", Effect.succeed("pushed")).pipe(Effect.flip)
    expect(next.message).toBe(cancelled)
  }),
)

it.live("disabling cascade restores admission after tool failure", () =>
  Effect.gen(function* () {
    const previous = process.env.MIMOCODE_DISABLE_FAIL_CASCADE
    process.env.MIMOCODE_DISABLE_FAIL_CASCADE = "true"
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previous == null) delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
        else process.env.MIMOCODE_DISABLE_FAIL_CASCADE = previous
      }),
    )
    const gate = new ToolGate()
    yield* gate.run("edit", "first", Effect.fail(new Error("failed"))).pipe(Effect.exit)
    expect(yield* gate.run("bash", "second", Effect.succeed("executed"))).toBe("executed")
  }),
)
