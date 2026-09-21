import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { ToolGate, type WorktreeGate } from "../../src/tool/gate"

const it = testEffect(Layer.empty)

let seq = 0
function key(): string {
  seq += 1
  return `test/gate-worktree-${seq}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function expectPending(p: Promise<unknown>): Promise<void> {
  let settled = false
  void p.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await sleep(15)
  expect(settled).toBe(false)
}

afterEach(() => {
  ToolGate.reset()
})

describe("tool.gate execution", () => {
  it.live("fiber interruption removes a waiter without waiting for the active tool", () =>
    Effect.gen(function* () {
      const gate = ToolGate.for(key())
      const held = yield* Effect.promise(() => gate.enter("bash", "held"))
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.leave(held)))
      const fiber = yield* gate.run("write", "queued", Effect.die("cancelled tool ran")).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(gate.queuedCount).toBe(1)
      yield* Fiber.interrupt(fiber).pipe(Effect.timeout("1 second"))
      expect(gate.queuedCount).toBe(0)
      expect(gate.runningCount).toBe(1)
    }),
  )

  it.live("interruption immediately after admission does not leak the slot", () =>
    Effect.gen(function* () {
      const gate = ToolGate.for(key())
      const held = yield* Effect.promise(() => gate.enter("bash", "held"))
      const fiber = yield* gate.run("write", "queued", Effect.never).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(gate.queuedCount).toBe(1)
      gate.leave(held)
      yield* Fiber.interrupt(fiber).pipe(Effect.timeout("1 second"))
      expect(gate.queuedCount).toBe(0)
      expect(gate.runningCount).toBe(0)
    }),
  )

  it.live("abort immediately after admission prevents the tool body from starting", () =>
    Effect.gen(function* () {
      const gate = ToolGate.for(key())
      const ctrl = new AbortController()
      const held = yield* Effect.promise(() => gate.enter("bash", "held"))
      let ran = false
      const fiber = yield* gate
        .run(
          "write",
          "queued",
          Effect.sync(() => {
            ran = true
          }),
          { signal: ctrl.signal },
        )
        .pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      gate.leave(held)
      ctrl.abort()
      const exit = yield* Fiber.join(fiber)
      expect(exit._tag).toBe("Failure")
      expect(ran).toBe(false)
      expect(gate.runningCount).toBe(0)
    }),
  )

  it.live("interrupted execution retains the slot until cleanup completes", () =>
    Effect.gen(function* () {
      const gate = ToolGate.for(key())
      const started = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const fiber = yield* gate
        .run(
          "bash",
          "active",
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Effect.never
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Deferred.succeed(cleaning, undefined)
                yield* Deferred.await(finish)
              }),
            ),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const stopping = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
      yield* Deferred.await(cleaning)
      const next = gate.enter("write", "next")
      expect(gate.queuedCount).toBe(1)
      expect(gate.runningCount).toBe(1)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(stopping)
      gate.leave(yield* Effect.promise(() => next))
      expect(gate.runningCount).toBe(0)
    }),
  )

  it.live("tool failure releases its slot", () =>
    Effect.gen(function* () {
      const gate = ToolGate.for(key())
      yield* gate.run("bash", "failed", Effect.fail(new Error("tool failed"))).pipe(Effect.exit)
      expect(gate.runningCount).toBe(0)
      const next = yield* Effect.promise(() => gate.enter("read", "next"))
      gate.leave(next)
    }),
  )
})

describe("tool.gate", () => {
  test("read/grep/glob enter concurrently without leave", async () => {
    const gate = ToolGate.for(key())
    const tokens = await Promise.all([gate.enter("read", "r1"), gate.enter("grep", "g1"), gate.enter("glob", "gl1")])
    expect(gate.runningCount).toBe(3)
    expect(gate.queuedCount).toBe(0)
    tokens.forEach((token) => gate.leave(token))
  })

  test.each(["edit", "write", "apply_patch", "bash", "task", "question", "plan_exit", "mcp_example", "custom"])(
    "%s is exclusive against reads and itself",
    async (tool) => {
      const gate = ToolGate.for(key())
      const first = await gate.enter(tool, "first")
      const read = gate.enter("read", "read")
      const next = gate.enter(tool, "next")
      await expectPending(read)
      await expectPending(next)
      gate.leave(first)
      const reading = await read
      await expectPending(next)
      gate.leave(reading)
      gate.leave(await next)
      expect(gate.runningCount).toBe(0)
    },
  )

  test("edit and write serialize without inspecting their arguments or paths", async () => {
    const gate = ToolGate.for(key())
    const first = await gate.enter("edit", "edit")
    const next = gate.enter("write", "write")
    await expectPending(next)
    expect(gate.runningCount).toBe(1)
    gate.leave(first)
    gate.leave(await next)
  })

  test("FIFO head-of-line barrier blocks later compatible reads", async () => {
    const gate = ToolGate.for(key())
    const first = await gate.enter("read", "first")
    const barrier = gate.enter("bash", "barrier")
    const next = gate.enter("read", "next")
    await expectPending(barrier)
    await expectPending(next)
    gate.leave(first)
    const token = await barrier
    await expectPending(next)
    gate.leave(token)
    gate.leave(await next)
  })

  test("queued readonly tools unlock together after a barrier leaves", async () => {
    const gate = ToolGate.for(key())
    const held = await gate.enter("bash", "held")
    const reads = Promise.all([gate.enter("read", "r1"), gate.enter("grep", "g1"), gate.enter("glob", "gl1")])
    const next = gate.enter("bash", "next")
    await expectPending(reads)
    gate.leave(held)
    const tokens = await reads
    expect(gate.runningCount).toBe(3)
    await expectPending(next)
    tokens.forEach((token) => gate.leave(token))
    gate.leave(await next)
  })

  test("leave is idempotent and unknown tokens are ignored", async () => {
    const gate = ToolGate.for(key())
    const token = await gate.enter("bash", "first")
    gate.leave(token)
    gate.leave(token)
    gate.leave("unknown")
    expect(gate.runningCount).toBe(0)
    expect(gate.queuedCount).toBe(0)
  })

  test("duplicate call ids receive distinct tokens", async () => {
    const gate = ToolGate.for(key())
    const first = await gate.enter("read", "?")
    const second = await gate.enter("read", "?")
    expect(first).not.toBe(second)
    gate.leave(first)
    expect(gate.runningCount).toBe(1)
    gate.leave(second)
  })

  test("already-aborted calls never enter", async () => {
    const gate = ToolGate.for(key())
    const ctrl = new AbortController()
    ctrl.abort()
    expect(
      await gate.enter("write", "cancelled", { signal: ctrl.signal }).catch((error: unknown) => error),
    ).toMatchObject({ name: "AbortError" })
    expect(gate.runningCount).toBe(0)
    expect(gate.queuedCount).toBe(0)
  })

  test("aborting a waiter removes only that queued call", async () => {
    const gate = ToolGate.for(key())
    const held = await gate.enter("bash", "held")
    const ctrl = new AbortController()
    const queued = gate.enter("write", "cancelled", { signal: ctrl.signal })
    const next = gate.enter("read", "next")
    ctrl.abort()
    expect(await queued.catch((error: unknown) => error)).toMatchObject({ name: "AbortError" })
    expect(gate.queuedCount).toBe(1)
    expect(gate.runningCount).toBe(1)
    gate.leave(held)
    gate.leave(await next)
  })

  test("abort after admission holds the slot until execution finishes", async () => {
    const gate = ToolGate.for(key())
    const ctrl = new AbortController()
    const token = await gate.enter("bash", "active", { signal: ctrl.signal })
    ctrl.abort()
    const next = gate.enter("write", "next")
    await expectPending(next)
    expect(gate.runningCount).toBe(1)
    gate.leave(token)
    gate.leave(await next)
  })

  test("aborting a queued barrier admits compatible calls behind it", async () => {
    const gate = ToolGate.for(key())
    const held = await gate.enter("read", "held")
    const ctrl = new AbortController()
    const barrier = gate.enter("bash", "cancelled", { signal: ctrl.signal })
    const next = gate.enter("read", "next")
    ctrl.abort()
    expect(await barrier.catch((error: unknown) => error)).toMatchObject({ name: "AbortError" })
    const token = await next
    expect(gate.runningCount).toBe(2)
    gate.leave(held)
    gate.leave(token)
  })

  test.each(["actor", "exec", "workflow", "session"])("%s bypasses a held gate", async (tool) => {
    const gate = ToolGate.for(key())
    const held = await gate.enter("bash", "held")
    const bypass = await gate.enter(tool, "bypass")
    const nested = gate.enter("read", "child-read")
    await expectPending(nested)
    expect(gate.runningCount).toBe(1)
    gate.leave(bypass)
    expect(gate.runningCount).toBe(1)
    gate.leave(held)
    gate.leave(await nested)
  })

  test("gates are isolated per Instance.directory", async () => {
    const first = ToolGate.for(key())
    const second = ToolGate.for(key())
    const a = await first.enter("bash", "first")
    const b = await second.enter("write", "second")
    expect(first.runningCount).toBe(1)
    expect(second.runningCount).toBe(1)
    first.leave(a)
    second.leave(b)
  })

  test("ToolGate.for returns the same instance for a directory", () => {
    const directory = key()
    const first: WorktreeGate = ToolGate.for(directory)
    const second: WorktreeGate = ToolGate.for(directory)
    expect(first).toBe(second)
  })
})
