import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { TaskTool } from "../../src/tool/task"
import { TaskRegistry } from "../../src/task/registry"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, TaskRegistry.defaultLayer),
)

async function parse(script: string) {
  const info = await runtime.runPromise(TaskTool)
  const def = await runtime.runPromise(info.init())
  if (!def.shell) throw new Error("task tool has no shell field")
  return runtime.runPromise(def.shell.parse(script))
}

async function parseFail(script: string) {
  const info = await runtime.runPromise(TaskTool)
  const def = await runtime.runPromise(info.init())
  const exit = await runtime.runPromise(Effect.exit(def.shell!.parse(script)))
  if (exit._tag !== "Failure") throw new Error("expected failure but got success")
  const cause: any = (exit as any).cause
  const fail = cause.reasons?.find?.((r: any) => r._tag === "Fail") ?? cause
  return fail.error ?? fail
}

describe("task.shell.parse: basic verbs", () => {
  test("create with summary", async () => {
    const out = await parse('task create "Implement auth"')
    expect(out).toEqual([{ operation: { action: "create", summary: "Implement auth" } }])
  })

  test("create subtask with --parent <TID>", async () => {
    const out = await parse('task create "Email login" --parent T1')
    expect(out).toEqual([{ operation: { action: "create", summary: "Email login", parent_id: "T1" } }])
  })

  test("create subtask with --parent=<TID> (equals form)", async () => {
    const out = await parse('task create "OAuth" --parent=T2.1')
    expect(out).toEqual([{ operation: { action: "create", summary: "OAuth", parent_id: "T2.1" } }])
  })

  test("list (no filter)", async () => {
    const out = await parse("task list")
    expect(out).toEqual([{ operation: { action: "list" } }])
  })

  test("list with status filter", async () => {
    const out = await parse("task list open")
    expect(out).toEqual([{ operation: { action: "list", status: "open" } }])
  })

  test("get by id", async () => {
    const out = await parse("task get T1")
    expect(out).toEqual([{ operation: { action: "get", id: "T1" } }])
  })

  test("rename", async () => {
    const out = await parse('task rename T1 "Updated title"')
    expect(out).toEqual([{ operation: { action: "rename", id: "T1", summary: "Updated title" } }])
  })
})

describe("task.shell.parse: lifecycle verbs", () => {
  test("block with reason", async () => {
    const out = await parse('task block T1 "waiting on spec clarification"')
    expect(out).toEqual([
      { operation: { action: "block", id: "T1", event_summary: "waiting on spec clarification" } },
    ])
  })

  test("unblock with reason", async () => {
    const out = await parse('task unblock T1 "spec resolved"')
    expect(out).toEqual([
      { operation: { action: "unblock", id: "T1", event_summary: "spec resolved" } },
    ])
  })

  test("done with summary", async () => {
    const out = await parse('task done T1 "all tests pass"')
    expect(out).toEqual([
      { operation: { action: "done", id: "T1", event_summary: "all tests pass" } },
    ])
  })

  test("abandon with reason", async () => {
    const out = await parse('task abandon T1 "out of scope"')
    expect(out).toEqual([
      { operation: { action: "abandon", id: "T1", event_summary: "out of scope" } },
    ])
  })
})

describe("task.shell.parse: dispatch errors", () => {
  test("unknown verb suggests close match (creat → create)", async () => {
    const err = await parseFail("task creat T1")
    expect(err.kind).toBe("unknown-verb")
    expect(err.detail).toContain("did you mean: create")
  })

  test("unknown verb suggests close match (donee → done)", async () => {
    const err = await parseFail("task donee T1")
    expect(err.kind).toBe("unknown-verb")
    expect(err.detail).toContain("did you mean: done")
  })

  test("create with wrong arity reports got/expected", async () => {
    const err = await parseFail("task create")
    expect(err.kind).toBe("arity")
    expect(err.detail).toContain("expected: task create <summary>")
  })

  test("block missing reason reports arity error", async () => {
    const err = await parseFail("task block T1")
    expect(err.kind).toBe("arity")
    expect(err.detail).toContain("expected: task block <id> <reason>")
  })

  test("done missing summary reports arity error", async () => {
    const err = await parseFail("task done T1")
    expect(err.kind).toBe("arity")
    expect(err.detail).toContain("expected: task done <id> <summary>")
  })
})

describe("task.shell.parse: multi-command", () => {
  test("two creates via newlines", async () => {
    const out = await parse('task create "A"\ntask create "B"')
    expect(out).toEqual([
      { operation: { action: "create", summary: "A" } },
      { operation: { action: "create", summary: "B" } },
    ])
  })

  test("mixed lifecycle commands", async () => {
    const out = await parse('task create "Implement auth"\ntask done T1 "complete"')
    expect(out).toEqual([
      { operation: { action: "create", summary: "Implement auth" } },
      { operation: { action: "done", id: "T1", event_summary: "complete" } },
    ])
  })
})

describe("task.shell.parse: start", () => {
  test("start by id", async () => {
    const out = await parse("task start T1")
    expect(out).toEqual([{ operation: { action: "start", id: "T1" } }])
  })
  test("unstart is no longer a valid verb", async () => {
    const err = await parseFail("task unstart T1")
    expect(err.kind).toBe("unknown-verb")
  })
  test("start arity error with no id", async () => {
    const err = await parseFail("task start")
    expect(err).toBeDefined()
  })
})

describe("task.shell: deprecated verbs", () => {
  test("task progress reports unknown verb", async () => {
    const err = await parseFail('task progress T1 "x"')
    expect(err.kind).toBe("unknown-verb")
  })

  test("task revise reports unknown verb", async () => {
    const err = await parseFail("task revise T1 body x")
    expect(err.kind).toBe("unknown-verb")
  })

  test("task create_sub reports unknown verb", async () => {
    const err = await parseFail('task create_sub T1 "x"')
    expect(err.kind).toBe("unknown-verb")
  })

  test("task unblock maps to unblock op", async () => {
    const out = await parse('task unblock T1 "spec resolved"')
    expect(out).toEqual([
      { operation: { action: "unblock", id: "T1", event_summary: "spec resolved" } },
    ])
  })
})

describe("task.shell.parse: parity flags", () => {
  test("create with --session", async () => {
    const out = await parse('task create "X" --session ses_abc')
    expect(out).toEqual([{ operation: { action: "create", summary: "X", session_id: "ses_abc" } }])
  })
  test("create with --parent and --session", async () => {
    const out = await parse('task create "X" --parent T1 --session ses_abc')
    expect(out).toEqual([{ operation: { action: "create", summary: "X", parent_id: "T1", session_id: "ses_abc" } }])
  })
  test("start with --reason maps to event_summary", async () => {
    const out = await parse('task start T1 --reason "picking this up"')
    expect(out).toEqual([{ operation: { action: "start", id: "T1", event_summary: "picking this up" } }])
  })
  test("start with --session", async () => {
    const out = await parse("task start T1 --session ses_abc")
    expect(out).toEqual([{ operation: { action: "start", id: "T1", session_id: "ses_abc" } }])
  })
  test("get with --session", async () => {
    const out = await parse("task get T1 --session ses_abc")
    expect(out).toEqual([{ operation: { action: "get", id: "T1", session_id: "ses_abc" } }])
  })
  test("list with --include-terminal and --include-archived (booleans)", async () => {
    const out = await parse("task list --include-terminal --include-archived")
    expect(out).toEqual([{ operation: { action: "list", include_terminal: true, include_archived: true } }])
  })
  test("list with status and --session", async () => {
    const out = await parse("task list open --session ses_abc")
    expect(out).toEqual([{ operation: { action: "list", status: "open", session_id: "ses_abc" } }])
  })
  test("done with reason and --session", async () => {
    const out = await parse('task done T1 "all tests pass" --session ses_abc')
    expect(out).toEqual([{ operation: { action: "done", id: "T1", event_summary: "all tests pass", session_id: "ses_abc" } }])
  })
  test("rename with --session", async () => {
    const out = await parse('task rename T1 "New title" --session ses_abc')
    expect(out).toEqual([{ operation: { action: "rename", id: "T1", summary: "New title", session_id: "ses_abc" } }])
  })

  test("dangling value flag (--session with no value) errors, not silent drop", async () => {
    const err = await parseFail("task get T1 --session")
    expect(err.kind).toBe("flag")
    expect(err.detail).toContain("--session requires a value")
  })

  test("empty value flag (--session=) errors", async () => {
    const err = await parseFail("task get T1 --session=")
    expect(err.kind).toBe("flag")
    expect(err.detail).toContain("--session requires a value")
  })
})
