import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ToolGate, toolResource, type WorktreeGate } from "../../src/tool/gate"

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
    await Promise.all([gate.enter("read", "r1"), gate.enter("grep", "g1"), gate.enter("glob", "gl1")])
    expect(gate.runningCount).toBe(3)
    expect(gate.queuedCount).toBe(0)
  })

  test("edit/write on different realpaths run concurrently", async () => {
    const gate = ToolGate.for(key())
    const a = path.join("/tmp/example", "a.ts")
    const b = path.join("/tmp/example", "b.ts")
    const t1 = await gate.enter("edit", "e1", { resource: toolResource("edit", { file_path: a }) })
    const t2 = await gate.enter("write", "w1", { resource: toolResource("write", { file_path: b }) })
    expect(gate.runningCount).toBe(2)
    gate.leave(t1)
    gate.leave(t2)
  })

  test("edit/write on the same realpath serialize", async () => {
    const gate = ToolGate.for(key())
    const file = path.join("/tmp/example", "same.ts")
    const resource = toolResource("edit", { file_path: file })
    const t1 = await gate.enter("edit", "e1", { resource })
    const pending = gate.enter("write", "w1", { resource })
    await expectPending(pending)
    expect(gate.runningCount).toBe(1)
    gate.leave(t1)
    const t2 = await pending
    gate.leave(t2)
  })

  test("edit without resource is barrier-class against another edit", async () => {
    const gate = ToolGate.for(key())
    const t1 = await gate.enter("edit", "e1")
    const pending = gate.enter("edit", "e2")
    await expectPending(pending)
    gate.leave(t1)
    await pending
  })

  test("edit does not parallelize with running read", async () => {
    const gate = ToolGate.for(key())
    const r1 = await gate.enter("read", "r1")
    const edit = gate.enter("edit", "e1", {
      resource: toolResource("edit", { file_path: path.join("/tmp/example", "a.ts") }),
    })
    await expectPending(edit)
    gate.leave(r1)
    await edit
  })

  test("apply_patch stays barrier-class with edit and itself", async () => {
    const gate = ToolGate.for(key())
    const edit = await gate.enter("edit", "e1", {
      resource: toolResource("edit", { file_path: path.join("/tmp/example", "a.ts") }),
    })
    const patch = gate.enter("apply_patch", "p1")
    await expectPending(patch)
    gate.leave(edit)
    const patchToken = await patch
    const patch2 = gate.enter("apply_patch", "p2")
    await expectPending(patch2)
    gate.leave(patchToken)
    await patch2
  })

  test("bash is barrier-class against path writes and readonly", async () => {
    const gate = ToolGate.for(key())
    const b1 = await gate.enter("bash", "b1")
    const edit = gate.enter("edit", "e1", {
      resource: toolResource("edit", { file_path: path.join("/tmp/example", "a.ts") }),
    })
    const read = gate.enter("read", "r1")
    await expectPending(edit)
    await expectPending(read)
    gate.leave(b1)
    const editToken = await edit
    await expectPending(read)
    gate.leave(editToken)
    await read
  })

  test("FIFO head-of-line: bash blocks a later read from overtaking", async () => {
    const gate = ToolGate.for(key())
    const b1 = await gate.enter("bash", "b1")
    const queuedBash = gate.enter("bash", "b2")
    const queuedRead = gate.enter("read", "r1")
    await expectPending(queuedBash)
    await expectPending(queuedRead)
    gate.leave(b1)
    const b2Token = await queuedBash
    await expectPending(queuedRead)
    gate.leave(b2Token)
    await queuedRead
  })

  test("cascade admit: distinct path writes unlock together after barrier leaves", async () => {
    const gate = ToolGate.for(key())
    const b1 = await gate.enter("bash", "b1")
    const e1 = gate.enter("edit", "e1", {
      resource: toolResource("edit", { file_path: path.join("/tmp/example", "a.ts") }),
    })
    const w1 = gate.enter("write", "w1", {
      resource: toolResource("write", { file_path: path.join("/tmp/example", "b.ts") }),
    })
    const b2 = gate.enter("bash", "b2")
    await expectPending(e1)
    gate.leave(b1)
    const e1Token = await e1
    const w1Token = await w1
    expect(gate.runningCount).toBe(2)
    await expectPending(b2)
    gate.leave(e1Token)
    gate.leave(w1Token)
    await b2
  })

  test("leave is idempotent and unknown tokens are ignored", async () => {
    const gate = ToolGate.for(key())
    const token = await gate.enter("read", "r1")
    gate.leave("missing")
    gate.leave(token)
    gate.leave(token)
    expect(gate.runningCount).toBe(0)
  })

  test("colliding callIDs still get unique admission tokens", async () => {
    const gate = ToolGate.for(key())
    const t1 = await gate.enter("bash", "?")
    const pending = gate.enter("bash", "?")
    await expectPending(pending)
    expect(gate.runningCount).toBe(1)
    gate.leave(t1)
    const t2 = await pending
    expect(t2).not.toBe(t1)
    gate.leave(t2)
    expect(gate.runningCount).toBe(0)
  })

  test("abort while queued dequeues without admitting", async () => {
    const gate = ToolGate.for(key())
    const held = await gate.enter("bash", "b1")
    const ctrl = new AbortController()
    const queued = gate.enter("read", "r1", { signal: ctrl.signal })
    await expectPending(queued)
    expect(gate.queuedCount).toBe(1)
    ctrl.abort()
    expect(await queued.catch((error: unknown) => error)).toMatchObject({ name: "AbortError" })
    expect(gate.queuedCount).toBe(0)
    expect(gate.runningCount).toBe(1)
    gate.leave(held)
    const next = await gate.enter("read", "r2")
    gate.leave(next)
  })

  test("abort after admission holds the slot until execution finishes", async () => {
    const gate = ToolGate.for(key())
    const ctrl = new AbortController()
    const token = await gate.enter("bash", "b1", { signal: ctrl.signal })
    expect(gate.runningCount).toBe(1)
    ctrl.abort()
    const next = gate.enter("write", "w1")
    await expectPending(next)
    expect(gate.runningCount).toBe(1)
    gate.leave(token)
    gate.leave(await next)
  })

  test("aborting a queued barrier admits compatible calls behind it", async () => {
    const gate = ToolGate.for(key())
    const held = await gate.enter("read", "r1")
    const ctrl = new AbortController()
    const barrier = gate.enter("bash", "b1", { signal: ctrl.signal })
    const next = gate.enter("read", "r2")
    ctrl.abort()
    expect(await barrier.catch((error: unknown) => error)).toMatchObject({ name: "AbortError" })
    await sleep(5)
    expect(gate.runningCount).toBe(2)
    gate.leave(held)
    gate.leave(await next)
  })

  test("actor/exec/workflow/session bypass the gate so nested tools do not deadlock", async () => {
    const gate = ToolGate.for(key())
    const held = await gate.enter("bash", "b1")
    const actorToken = await gate.enter("actor", "actor-run")
    const execToken = await gate.enter("exec", "exec-1")
    const workflowToken = await gate.enter("workflow", "wf-1")
    const sessionToken = await gate.enter("session", "session-join")
    // Nested tools still queue behind the outer bash barrier.
    const nested = gate.enter("read", "child-read")
    await expectPending(nested)
    expect(gate.runningCount).toBe(1)
    gate.leave(actorToken)
    gate.leave(execToken)
    gate.leave(workflowToken)
    gate.leave(sessionToken)
    gate.leave(held)
    const nestedToken = await nested
    gate.leave(nestedToken)
  })

  test("toolResource resolves edit/write paths and ignores other tools", () => {
    const file = path.join("/tmp/example", "x.ts")
    expect(toolResource("edit", { file_path: file })).toBe(toolResource("write", { file_path: file }))
    expect(toolResource("bash", { file_path: file })).toBeUndefined()
    expect(toolResource("edit", {})).toBeUndefined()
  })

  test("relative and absolute paths in the session directory share a resource", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "target.txt")
    await Bun.write(file, "before")
    expect(toolResource("edit", { file_path: "target.txt" }, tmp.path)).toBe(
      toolResource("write", { file_path: file }, tmp.path),
    )
  })

  test("new files under a symlinked parent share a resource", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "real"))
    await fs.symlink(
      path.join(tmp.path, "real"),
      path.join(tmp.path, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    )
    expect(toolResource("write", { file_path: path.join(tmp.path, "alias", "new.txt") })).toBe(
      toolResource("write", { file_path: path.join(tmp.path, "real", "new.txt") }),
    )
  })

  test("gates are isolated per Instance.directory", async () => {
    const a = ToolGate.for(key())
    const b = ToolGate.for(key())
    expect(a).not.toBe(b)
    await a.enter("bash", "b1")
    const bEdit = await b.enter("edit", "e1", {
      resource: toolResource("edit", { file_path: path.join("/tmp/example", "a.ts") }),
    })
    expect(b.runningCount).toBe(1)
    expect(a.runningCount).toBe(1)
    b.leave(bEdit)
  })

  test("ToolGate.for returns the same instance for a directory", async () => {
    const dir = key()
    const first: WorktreeGate = ToolGate.for(dir)
    const second: WorktreeGate = ToolGate.for(dir)
    expect(first).toBe(second)
  })
})
