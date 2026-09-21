import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { ToolGate, toolResource, type WorktreeGate } from "../../src/tool/gate"

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
    await expect(queued).rejects.toThrow()
    expect(gate.queuedCount).toBe(0)
    expect(gate.runningCount).toBe(1)
    gate.leave(held)
    const next = await gate.enter("read", "r2")
    gate.leave(next)
  })

  test("abort after admission releases the running slot", async () => {
    const gate = ToolGate.for(key())
    const ctrl = new AbortController()
    const token = await gate.enter("bash", "b1", { signal: ctrl.signal })
    expect(gate.runningCount).toBe(1)
    ctrl.abort()
    await sleep(5)
    expect(gate.runningCount).toBe(0)
    gate.leave(token)
  })

  test("actor/exec/workflow bypass the gate so nested tools do not deadlock", async () => {
    const gate = ToolGate.for(key())
    const held = await gate.enter("bash", "b1")
    const actorToken = await gate.enter("actor", "actor-run")
    const execToken = await gate.enter("exec", "exec-1")
    const workflowToken = await gate.enter("workflow", "wf-1")
    // Nested tools still queue behind the outer bash barrier.
    const nested = gate.enter("read", "child-read")
    await expectPending(nested)
    expect(gate.runningCount).toBe(1)
    gate.leave(actorToken)
    gate.leave(execToken)
    gate.leave(workflowToken)
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
