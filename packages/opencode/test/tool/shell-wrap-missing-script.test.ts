import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { shellWrap } from "../../src/tool/shell-wrap"
import * as Tool from "../../src/tool/tool"

// Minimal shell-style tool def: its shell.parse would crash on undefined input
// (mirrors the real tokenize(script.trim()) path), so the guard must short-circuit
// BEFORE parse is ever called.
function fakeShellDef(): Tool.Def {
  return {
    id: "actor",
    description: "fake",
    parameters: {} as never,
    execute: () => Effect.succeed({ title: "ok", output: "ran", metadata: {} }),
    shell: {
      description: "fake shell desc",
      parse: (script: string) => Effect.sync(() => {
        if (typeof script !== "string") throw new TypeError("undefined is not an object (evaluating 'script.trim')")
        return [{ operation: "run" }] as never
      }),
    },
  }
}

const ctx = {
  sessionID: "ses_x" as never,
  messageID: "msg_x" as never,
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} as unknown as Tool.Context

describe("shellWrap: missing/invalid script guard", () => {
  test("undefined script → structured teaching error, no crash", async () => {
    const wrapped = shellWrap(fakeShellDef())
    const result = await Effect.runPromise(wrapped.execute({ script: undefined } as never, ctx))
    expect(result.output.toLowerCase()).toContain("script")
    expect(result.metadata).toMatchObject({ commands: 0, success: 0 })
    expect(result.output).not.toContain("script.trim")
    expect(result.output).toContain("actor")
  })

  test("non-string script → same structured error", async () => {
    const wrapped = shellWrap(fakeShellDef())
    const result = await Effect.runPromise(wrapped.execute({ script: { description: "x" } } as never, ctx))
    expect(result.output.toLowerCase()).toContain("script")
    expect(result.metadata).toMatchObject({ commands: 0, success: 0 })
  })

  test("empty/whitespace script → structured error", async () => {
    const wrapped = shellWrap(fakeShellDef())
    const result = await Effect.runPromise(wrapped.execute({ script: "   " } as never, ctx))
    expect(result.output.toLowerCase()).toContain("script")
    expect(result.metadata).toMatchObject({ commands: 0, success: 0 })
  })

  test("valid script still works (guard doesn't over-reject)", async () => {
    const wrapped = shellWrap(fakeShellDef())
    const result = await Effect.runPromise(wrapped.execute({ script: "actor run explore \"d\" \"p\"" } as never, ctx))
    expect(result.metadata).toMatchObject({ commands: 1, success: 1 })
  })
})

describe("shellWrap: recover routing", () => {
  function recordingDef(recover?: (a: unknown) => unknown) {
    const received: unknown[] = []
    const def = {
      id: "actor",
      description: "fake",
      parameters: {} as never,
      execute: (args: unknown) =>
        Effect.sync(() => {
          received.push(args)
          return { title: "ok", output: "actor_id: explore-1", metadata: { actorId: "explore-1" } }
        }),
      shell: {
        description: "fake shell desc",
        parse: (_s: string) => Effect.succeed([] as never),
        ...(recover ? { recover } : {}),
      },
    } as unknown as Tool.Def
    return { def, received }
  }

  test("recover returns op → routed to execute, success is silent (no format hint)", async () => {
    const recovered = { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p" } }
    const { def, received } = recordingDef(() => recovered)
    const wrapped = shellWrap(def)
    const result = await Effect.runPromise(wrapped.execute({ description: "d", prompt: "p", subagent_type: "explore" } as never, ctx))
    expect(received).toEqual([recovered])
    expect(result.metadata).toMatchObject({ commands: 1, success: 1 })
    expect(result.output).toContain("actor_id: explore-1")
    expect(result.output.toLowerCase()).not.toContain("takes a single")
    expect(result.output.toLowerCase()).not.toContain("operation")
  })

  test("recover undefined + jsonish args → JSON teaching", async () => {
    const { def } = recordingDef(() => undefined)
    const wrapped = shellWrap(def)
    const result = await Effect.runPromise(wrapped.execute({ description: "d", prompt: "p", subagent_type: "explore" } as never, ctx))
    expect(result.metadata).toMatchObject({ commands: 0, success: 0 })
    expect(result.output.toLowerCase()).toContain("operation")
  })

  test("recover undefined + had empty script key → shell teaching", async () => {
    const { def } = recordingDef(() => undefined)
    const wrapped = shellWrap(def)
    const result = await Effect.runPromise(wrapped.execute({ script: "   " } as never, ctx))
    expect(result.metadata).toMatchObject({ commands: 0, success: 0 })
    expect(result.output.toLowerCase()).toContain("script")
    expect(result.output.toLowerCase()).not.toContain("operation")
  })

  test("recover returns op but execute fails → JSON teaching", async () => {
    const recovered = { operation: { action: "run" } }
    const def = {
      id: "actor", description: "fake", parameters: {} as never,
      execute: () => Effect.fail(new Error("validation: missing prompt")),
      shell: { description: "d", parse: (_s: string) => Effect.succeed([] as never), recover: () => recovered },
    } as unknown as Tool.Def
    const wrapped = shellWrap(def)
    const result = await Effect.runPromise(wrapped.execute({ description: "d" } as never, ctx))
    expect(result.metadata).toMatchObject({ commands: 0, success: 0 })
    expect(result.output.toLowerCase()).toContain("operation")
  })
})
