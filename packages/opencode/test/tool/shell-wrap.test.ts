import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { Truncate, Tool } from "../../src/tool"
import { shellWrap } from "../../src/tool/shell-wrap"

const runtime = ManagedRuntime.make(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

// Convention: every shell-style tool's parameters must have `operation: string`
// as the discriminator. This synthetic tool follows that convention.
const params = z.object({ operation: z.string(), value: z.string().optional() })

function makeRecordingTool(record: { calls: z.infer<typeof params>[] }): Tool.Def<typeof params> {
  return {
    id: "synthetic",
    description: "json description",
    parameters: params,
    execute: (args) => {
      record.calls.push(args)
      return Effect.succeed({
        title: `synthetic ${args.operation}`,
        output: `ran ${args.operation}${args.value ? " " + args.value : ""}`,
        metadata: { operation: args.operation },
      })
    },
    shell: {
      description: "shell description",
      parse: (script) =>
        Effect.succeed(
          script
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((line) => {
              const tokens = line.trim().split(/\s+/)
              return { operation: tokens[1], value: tokens[2] } as z.infer<typeof params>
            }),
        ),
    },
  }
}

describe("shellWrap: single command", () => {
  test("wrapped Def exposes shellInputSchema and shell description", () => {
    const record = { calls: [] as z.infer<typeof params>[] }
    const original = makeRecordingTool(record)
    const wrapped = shellWrap(original)
    expect(wrapped.description).toBe("shell description")
    const parsed = wrapped.parameters.parse({ script: "synthetic create" })
    expect(parsed).toEqual({ script: "synthetic create" })
    expect(() => wrapped.parameters.parse({ script: "" })).toThrow()
  })

  test("execute parses script, calls original execute once, wraps output", async () => {
    const record = { calls: [] as z.infer<typeof params>[] }
    const original = makeRecordingTool(record)
    const wrapped = shellWrap(original)
    const ctx = stubCtx()
    const result = await runtime.runPromise(wrapped.execute({ script: "synthetic create" }, ctx))
    expect(record.calls).toEqual([{ operation: "create", value: undefined }])
    expect(result.output).toContain('<command index="1" operation="create">')
    expect(result.output).toContain("ran create")
    expect(result.output).toContain("</command>")
    expect(result.metadata).toEqual({ operation: "create", commands: 1, success: 1 })
  })
})

function stubCtx(): Tool.Context {
  return {
    sessionID: "ses_synth" as any,
    messageID: "msg_synth" as any,
    agent: "general",
    abort: new AbortController().signal,
    messages: [] as any,
    metadata: () => Effect.succeed(undefined),
    ask: () => Effect.succeed(undefined),
  }
}

describe("shellWrap: multi-command", () => {
  test("two commands run in order, both succeed, metadata reflects last + counts", async () => {
    const record = { calls: [] as z.infer<typeof params>[] }
    const original = makeRecordingTool(record)
    const wrapped = shellWrap(original)
    const result = await runtime.runPromise(
      wrapped.execute({ script: "synthetic create A\nsynthetic update B" }, stubCtx()),
    )
    expect(record.calls).toEqual([
      { operation: "create", value: "A" },
      { operation: "update", value: "B" },
    ])
    expect(result.output.match(/<command/g)?.length).toBe(2)
    expect(result.metadata).toEqual({ operation: "update", commands: 2, success: 2 })
  })

  test("set-e: failure on cmd #2 stops; cmd #3 marked not-executed", async () => {
    const record = { calls: [] as z.infer<typeof params>[] }
    const original: Tool.Def<typeof params> = {
      ...makeRecordingTool(record),
      execute: (args) => {
        record.calls.push(args)
        if (args.operation === "boom") {
          return Effect.fail(new Error(`tool boom on ${args.value}`)) as any
        }
        return Effect.succeed({
          title: `synthetic ${args.operation}`,
          output: `ran ${args.operation}`,
          metadata: { operation: args.operation },
        })
      },
    }
    const wrapped = shellWrap(original)
    const result = await runtime.runPromise(
      wrapped.execute(
        { script: "synthetic create A\nsynthetic boom B\nsynthetic create C" },
        stubCtx(),
      ),
    )
    expect(record.calls.map((c) => c.operation)).toEqual(["create", "boom"])
    expect(result.output).toContain('<command index="2" operation=')
    expect(result.output).toContain('failed="true"')
    expect(result.output).toContain("tool boom on B")
    expect(result.output).toContain("<not-executed>commands #3..#3</not-executed>")
    expect(result.metadata).toEqual({ commands: 3, success: 1 })
  })
})

describe("shellWrap: parse errors", () => {
  test("shell.parse failure → single envelope, no execute calls, no operation attribute", async () => {
    const record = { calls: [] as z.infer<typeof params>[] }
    const original: Tool.Def<typeof params> = {
      ...makeRecordingTool(record),
      shell: {
        description: "shell description",
        parse: () =>
          Effect.fail({
            kind: "unsupported-operator",
            line: 2,
            detail: "unsupported shell operator: |",
          }),
      },
    }
    const wrapped = shellWrap(original)
    const result = await runtime.runPromise(wrapped.execute({ script: "anything" }, stubCtx()))
    expect(record.calls).toEqual([])
    expect(result.output).toContain('<command failed="true">')
    expect(result.output).not.toContain("operation=")
    expect(result.output).toContain("synthetic: parse error at line 2")
    expect(result.output).toContain("unsupported shell operator: |")
    expect(result.metadata).toEqual({ commands: 0, success: 0 })
  })
})

describe("shellWrap: edge cases", () => {
  test("whitespace-only script returns error envelope, no execute calls", async () => {
    const record = { calls: [] as z.infer<typeof params>[] }
    const original = makeRecordingTool(record)
    const wrapped = shellWrap(original)
    const result = await runtime.runPromise(wrapped.execute({ script: "   \n  " }, stubCtx()))
    expect(record.calls).toEqual([])
    expect(result.output).toContain('<command failed="true">')
    // Whitespace-only now short-circuits at the missing-script guard (before
    // shell.parse), which returns the teaching envelope rather than the
    // post-parse "no commands found" message. Contract is unchanged: no execute
    // calls, error envelope, zeroed metadata.
    expect(result.output).toContain("synthetic: this tool takes a single `script` string")
    expect(result.metadata).toEqual({ commands: 0, success: 0 })
  })

  test("non-empty script that parses to zero commands hits the post-parse empty branch", async () => {
    // The missing-script guard only catches missing/empty/whitespace input. A
    // non-empty, non-whitespace script that the parser legitimately reduces to
    // zero commands (e.g. a comment-only script via the real tokenizer) still
    // reaches the distinct `parsedList.length === 0` branch — this keeps that
    // branch covered after whitespace was redirected to the guard.
    const record = { calls: [] as z.infer<typeof params>[] }
    const wrapped = shellWrap({
      ...makeRecordingTool(record),
      shell: {
        description: "shell description",
        parse: () => Effect.succeed([] as z.infer<typeof params>[]),
      },
    })
    const result = await runtime.runPromise(wrapped.execute({ script: "# just a comment" }, stubCtx()))
    expect(record.calls).toEqual([])
    expect(result.output).toContain('<command failed="true">')
    expect(result.output).toContain("synthetic: no commands found in script")
    expect(result.metadata).toEqual({ commands: 0, success: 0 })
  })
})

describe("shellWrap: nested discriminator (task-style)", () => {
  // The `task` tool's shell parser returns a NESTED discriminator
  // `{ operation: { action: "create", ... } }` (deliberately — see task.ts
  // .meta comment). shell-wrap must derive the attribute from `.action` and
  // never call `.replace` on the object (which crashed: "H.replace is not a
  // function").
  const nestedParams = z.object({
    operation: z.object({ action: z.string(), summary: z.string().optional() }),
  })

  function makeNestedTool(record: { calls: z.infer<typeof nestedParams>[] }): Tool.Def<typeof nestedParams> {
    return {
      id: "nested",
      description: "json description",
      parameters: nestedParams,
      execute: (args) => {
        record.calls.push(args)
        return Effect.succeed({
          title: `nested ${args.operation.action}`,
          output: `ran ${args.operation.action}`,
          metadata: { action: args.operation.action },
        })
      },
      shell: {
        description: "shell description",
        parse: (script) =>
          Effect.succeed(
            script
              .split("\n")
              .filter((l) => l.trim() !== "")
              .map((line) => {
                const tokens = line.trim().split(/\s+/)
                return { operation: { action: tokens[1], summary: tokens[2] } } as z.infer<typeof nestedParams>
              }),
          ),
      },
    }
  }

  test("does not throw and renders the action as the operation attribute", async () => {
    const record = { calls: [] as z.infer<typeof nestedParams>[] }
    const wrapped = shellWrap(makeNestedTool(record))
    const result = await runtime.runPromise(wrapped.execute({ script: "nested create x" }, stubCtx()))
    expect(record.calls).toEqual([{ operation: { action: "create", summary: "x" } }])
    expect(result.output).toContain('<command index="1" operation="create">')
    expect(result.output).not.toContain("[object Object]")
    expect(result.output).toContain("ran create")
  })

  test("nested discriminator in a failed command still renders the action attribute", async () => {
    const record = { calls: [] as z.infer<typeof nestedParams>[] }
    const base = makeNestedTool(record)
    const original: Tool.Def<typeof nestedParams> = {
      ...base,
      execute: (args) => {
        record.calls.push(args)
        return Effect.fail(new Error(`boom ${args.operation.action}`)) as any
      },
    }
    const wrapped = shellWrap(original)
    const result = await runtime.runPromise(wrapped.execute({ script: "nested start T1" }, stubCtx()))
    expect(result.output).toContain('operation="start"')
    expect(result.output).toContain('failed="true"')
    expect(result.output).not.toContain("[object Object]")
  })
})

describe("shellWrap: JSON double-escape rescue", () => {
  // A parser that chokes when the script arrives collapsed onto one physical line
  // via literal backslash-n (the JSON double-escape), but parses fine once real
  // newlines are restored — mirroring how the real tokenizer behaves.
  function makeNewlineSensitiveTool(record: { calls: z.infer<typeof params>[] }): Tool.Def<typeof params> {
    return {
      ...makeRecordingTool(record),
      shell: {
        description: "shell description",
        parse: (script) => {
          if (/\\n/.test(script))
            return Effect.fail({ kind: "unsupported-operator", line: 1, detail: "literal backslash-n" })
          return Effect.succeed(
            script
              .split("\n")
              .filter((l) => l.trim() !== "")
              .map((line) => {
                const tokens = line.trim().split(/\s+/)
                return { operation: tokens[1], value: tokens[2] } as z.infer<typeof params>
              }),
          )
        },
      },
    }
  }

  test("literal \\n collapsed script is repaired, re-parsed, and runs with a notice", async () => {
    const record = { calls: [] as z.infer<typeof params>[] }
    const wrapped = shellWrap(makeNewlineSensitiveTool(record))
    const result = await runtime.runPromise(
      wrapped.execute({ script: "synthetic create A\\nsynthetic update B" }, stubCtx()),
    )
    expect(record.calls).toEqual([
      { operation: "create", value: "A" },
      { operation: "update", value: "B" },
    ])
    expect(result.output).toContain("<notice>")
    expect(result.output).toContain("REAL line breaks")
    expect(result.output.match(/<command/g)?.length).toBe(2)
    expect(result.metadata).toEqual({ operation: "update", commands: 2, success: 2 })
  })

  test("nothing to repair → original parse error, no notice", async () => {
    const record = { calls: [] as z.infer<typeof params>[] }
    const wrapped = shellWrap({
      ...makeRecordingTool(record),
      shell: {
        description: "shell description",
        parse: () => Effect.fail({ kind: "unsupported-operator", line: 1, detail: "always fails" }),
      },
    })
    const result = await runtime.runPromise(wrapped.execute({ script: "synthetic create A" }, stubCtx()))
    expect(record.calls).toEqual([])
    expect(result.output).toContain('<command failed="true">')
    expect(result.output).not.toContain("<notice>")
    expect(result.output).toContain("always fails")
  })

  test("repair attempted but re-parse still fails → original error, no notice", async () => {
    const record = { calls: [] as z.infer<typeof params>[] }
    const wrapped = shellWrap({
      ...makeRecordingTool(record),
      shell: {
        description: "shell description",
        parse: () => Effect.fail({ kind: "unsupported-operator", line: 1, detail: "still broken" }),
      },
    })
    // Script carries literal \n so repair runs, but parse fails regardless.
    const result = await runtime.runPromise(
      wrapped.execute({ script: "synthetic create A\\nsynthetic update B" }, stubCtx()),
    )
    expect(record.calls).toEqual([])
    expect(result.output).toContain('<command failed="true">')
    expect(result.output).not.toContain("<notice>")
    expect(result.output).toContain("still broken")
  })
})
