import { describe, expect, test, afterAll } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import z from "zod"
import os from "os"
import fs from "fs/promises"
import path from "path"
import { evalScript } from "../../src/workflow/sandbox"
import { Agent } from "../../src/agent/agent"
import { Truncate, Tool } from "../../src/tool"
import {
  CODE_MODE_EXEC_GRAMMAR,
  ToolScriptTool,
  parseExecSource,
  renderToolScriptDeclarations,
  renderMcpToolScriptDeclarations,
} from "../../src/tool/tool-script"
import { toolScriptRegistry, NOT_CALLABLE_IN_EXEC } from "../../src/tool/tool-script-ref"
import { Instance } from "../../src/project/instance"
import { CodeModeWaitTool } from "../../src/tool/code-mode-wait"
import { createCodeModeOutputBuffer, startCell, waitCell } from "../../src/tool/code-mode-cell"

describe("sandbox non-deterministic mode", () => {
  test("deterministic:false keeps Date and Math.random", async () => {
    const result = (await evalScript(
      `return { hasDate: typeof Date === "function", rand: Math.random() }`,
      {},
      { deterministic: false },
    )) as { hasDate: boolean; rand: number }
    expect(result.hasDate).toBe(true)
    expect(result.rand).toBeGreaterThanOrEqual(0)
    expect(result.rand).toBeLessThan(1)
  })

  test("default mode still strips Date (workflow contract unchanged)", async () => {
    const result = await evalScript(`return typeof Date`, {})
    expect(result).toBe("undefined")
  })

  test("activeDeadlineMs kills runaway sync code", async () => {
    await expect(evalScript(`while (true) {}`, {}, { deterministic: false, activeDeadlineMs: 200 })).rejects.toThrow()
  })

  test("activeDeadlineMs does NOT charge time parked on a host hook", async () => {
    const hooks = {
      slow: async () => {
        await new Promise((r) => setTimeout(r, 300))
        return "ok"
      },
    }
    const result = await evalScript(`return await slow()`, hooks, {
      deterministic: false,
      activeDeadlineMs: 150,
    })
    expect(result).toBe("ok")
  })

  test("interrupt() stops the guest once it resumes after a host hook", async () => {
    // interrupt is polled during guest BYTECODE execution only. A pure sync spin
    // blocks the host event loop, so timer-driven aborts can't fire — the kill
    // for that case is activeDeadlineMs (Date-based, above). Here abort is set
    // while the guest is parked on a hook; the spin after resume is interrupted.
    let stop = false
    const hooks = {
      pause: async () => {
        await new Promise((r) => setTimeout(r, 50))
        stop = true
        return "ok"
      },
    }
    await expect(
      evalScript(`await pause(); while (true) {}`, hooks, { deterministic: false, interrupt: () => stop }),
    ).rejects.toThrow()
  })
})

const runtime = ManagedRuntime.make(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-test-toolscript-"))
afterAll(async () => {
  await Instance.disposeAll()
  await fs.rm(tmp, { recursive: true, force: true })
})

function fakeDef(id: string, execute: (args: any) => Promise<string>): Tool.Def {
  return {
    id,
    description: `fake ${id}`,
    parameters: z.object({ value: z.string().optional() }),
    execute: (args: any) =>
      Effect.promise(() => execute(args)).pipe(
        Effect.map((output) => ({ title: id, output, metadata: {} })),
      ),
  }
}

async function runToolScript(
  code: string,
  defs: Tool.Def[],
  abort?: AbortSignal,
  opts?: {
    ask?: () => Effect.Effect<void>
    maxToolCalls?: number
    timeoutMs?: number
    yieldTimeMs?: number
    maxOutputTokens?: number
    toolWhitelist?: string[]
    mcp?: Record<string, any>
    metadata?: (input: { title?: string; metadata: Tool.Metadata }) => Effect.Effect<void>
  },
) {
  const prev = toolScriptRegistry.current
  toolScriptRegistry.current = () => Effect.succeed(defs)
  try {
    return await Instance.provide({
      directory: tmp,
      fn: async () => {
        const info = await runtime.runPromise(ToolScriptTool)
        const def = await Effect.runPromise(Tool.init(info))
        return runtime.runPromise(
          def.execute(
            {
              code,
              ...(opts?.maxToolCalls !== undefined && { max_tool_calls: opts.maxToolCalls }),
              ...(opts?.timeoutMs !== undefined && { timeout: opts.timeoutMs }),
              ...(opts?.yieldTimeMs !== undefined && { yield_time_ms: opts.yieldTimeMs }),
              ...(opts?.maxOutputTokens !== undefined && { max_output_tokens: opts.maxOutputTokens }),
            },
            {
              sessionID: "ses_test" as any,
              messageID: "msg_test" as any,
              agent: "build",
              abort: abort ?? new AbortController().signal,
              callID: "call_test",
              extra: {
                ...(opts?.toolWhitelist ? { toolWhitelist: opts.toolWhitelist } : {}),
                ...(opts?.mcp ? { execMcp: { current: opts.mcp } } : {}),
              },
              messages: [],
              metadata: opts?.metadata ?? (() => Effect.void),
              ask: opts?.ask ?? (() => Effect.void),
            },
          ),
        )
      },
    })
  } finally {
    toolScriptRegistry.current = prev
  }
}

describe("exec", () => {
  test("uses the Codex freeform grammar and pragma schema", async () => {
    const info = await runtime.runPromise(ToolScriptTool)
    const def = await runtime.runPromise(Tool.init(info))

    expect(def.freeform?.format).toEqual({
      type: "grammar",
      syntax: "lark",
      definition: CODE_MODE_EXEC_GRAMMAR,
    })
    expect(def.description).toContain('// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}')
    expect(def.description).toContain("captured `console`")
    expect(def.description).toContain("jailed `files` helper")
    expect(def.description).toContain("Not part of the final return text")
    expect(def.description).toContain("It may be called repeatedly")
    expect(def.freeform?.parse('// @exec: {"yield_time_ms": 25, "max_output_tokens": 128}\nreturn 1')).toEqual({
      code: "return 1",
      yield_time_ms: 25,
      max_output_tokens: 128,
    })
  })

  test("parseExecSource rejects malformed pragmas like Codex", () => {
    expect(() => parseExecSource("")).toThrow("exec expects raw JavaScript or TypeScript source text")
    expect(() => parseExecSource('// @exec: {"yield_time_ms": 1}')).toThrow(
      "exec pragma must be followed by JavaScript source",
    )
    expect(() => parseExecSource('// @exec: {"unknown": 1}\nreturn 1')).toThrow(
      "exec pragma only supports `yield_time_ms` and `max_output_tokens`; got `unknown`",
    )
    expect(() => parseExecSource('// @exec: {"yield_time_ms": -1}\nreturn 1')).toThrow(
      "exec pragma field `yield_time_ms` must be a non-negative safe integer",
    )
    expect(() => parseExecSource('\n// @exec: {"yield_time_ms": 1}\nreturn 1')).toThrow(
      "exec pragma must be the first line",
    )
  })

  test("text helper emits output without requiring a return value", async () => {
    const result = await runToolScript(`text("first"); text({ second: 2 })`, [])
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain('first\n{"second":2}')
    expect(result.output).not.toContain("<return_value>\nundefined")
  })

  test("notify publishes metadata without entering the final return text", async () => {
    const notifications: string[] = []
    const result = await runToolScript(`notify("building"); return "done"`, [], undefined, {
      metadata: (input) =>
        Effect.sync(() => {
          if (typeof input.metadata.notification === "string") notifications.push(input.metadata.notification)
        }),
    })
    expect(result.output).toContain("done")
    expect(result.output).not.toContain("building")
    expect(notifications).toContain("building")
  })

  test("yielded scripts resume through the Codex wait tool", async () => {
    const result = await runToolScript(
      `const result = await tools.slow({}); text(result.output)`,
      [
        fakeDef("slow", async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return "finished"
        }),
      ],
      undefined,
      { yieldTimeMs: 0 },
    )
    expect(result.output).toContain("Script running with cell ID")
    const cellID = /Script running with cell ID ([^\s]+)/.exec(result.output)?.[1]
    expect(cellID).toBeDefined()

    const info = await runtime.runPromise(CodeModeWaitTool)
    const def = await runtime.runPromise(Tool.init(info))
    const waited = await Instance.provide({
      directory: tmp,
      fn: () =>
        runtime.runPromise(
          def.execute(
            { cell_id: cellID!, yield_time_ms: 1000 },
            {
              sessionID: "ses_test" as any,
              messageID: "msg_wait" as any,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          ),
        ),
    })
    expect(waited.output).toContain("Script completed")
    expect(waited.output).toContain("finished")
  })

  test("wait drains only output added since the previous yield", async () => {
    const result = await runToolScript(
      `text("one"); yield_control();
       await tools.pause({});
       text("two"); yield_control();
       await tools.pause({});
       text("three")`,
      [
        fakeDef("pause", async () => {
          await new Promise((resolve) => setTimeout(resolve, 30))
          return "ok"
        }),
      ],
    )
    const cellID = /Script running with cell ID ([^\s]+)/.exec(result.output)?.[1]
    expect(cellID).toBeDefined()
    expect(result.output).toContain("one")

    const second = await waitCell({ sessionID: "ses_test" as any, cellID: cellID!, yieldTimeMs: 1000 })
    expect(second.output).toContain("two")
    expect(second.output).not.toContain("one")

    const final = await waitCell({ sessionID: "ses_test" as any, cellID: cellID!, yieldTimeMs: 1000 })
    expect(final.output).toContain("three")
    expect(final.output).not.toContain("one")
    expect(final.output).not.toContain("two")
  })

  test("terminating an already-settled cell preserves its attachments", async () => {
    const promise = new Promise<Tool.ExecuteResult>((resolve) =>
      setTimeout(
        () =>
          resolve({
            title: "done",
            output: "done",
            metadata: { status: "completed" },
            attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,eA==" }],
          }),
        20,
      ),
    )
    const started = await startCell({
      sessionID: "ses_attachments" as any,
      promise,
      controller: new AbortController(),
      output: createCodeModeOutputBuffer(),
      yieldTimeMs: 0,
    })
    const cellID = /Script running with cell ID ([^\s]+)/.exec(started.output)?.[1]
    expect(cellID).toBeDefined()
    await promise
    const terminated = await waitCell({
      sessionID: "ses_attachments" as any,
      cellID: cellID!,
      yieldTimeMs: 0,
      terminate: true,
    })
    expect(terminated.metadata.status).toBe("terminated")
    expect(terminated.attachments).toHaveLength(1)
  })

  test("store writes commit only after successful script completion", async () => {
    const stored = await runToolScript(`store("committed", { ok: true }); return "stored"`, [])
    expect(stored.metadata.status).toBe("completed")
    const loaded = await runToolScript(`return load("committed")`, [])
    expect(loaded.output).toContain('"ok": true')

    const failed = await runToolScript(`store("failed", "leak"); throw new Error("stop")`, [])
    expect(failed.metadata.status).toBe("code_error")
    const afterFailure = await runToolScript(`return load("failed") ?? "missing"`, [])
    expect(afterFailure.output).toContain("missing")
    expect(afterFailure.output).not.toContain("leak")

    const cancelled = await runToolScript(`store("cancelled", "leak"); while (true) {}`, [], undefined, {
      timeoutMs: 50,
    })
    expect(cancelled.metadata.status).toBe("timeout")
    const afterCancel = await runToolScript(`return load("cancelled") ?? "missing"`, [])
    expect(afterCancel.output).toContain("missing")
    expect(afterCancel.output).not.toContain("leak")
  })

  test("cannot call tools outside the actor runtime whitelist", async () => {
    const result = await runToolScript(
      `return await tools.echo({ value: "blocked" })`,
      [fakeDef("echo", async () => "unexpected")],
      undefined,
      { toolWhitelist: ["exec"] },
    )

    expect(result.metadata.status).toBe("code_error")
    expect(result.output).toContain("echo")
    expect(result.output).not.toContain("unexpected")
  })

  test("executes code, calls tools, returns aggregated result", async () => {
    const seen: string[] = []
    const defs = [
      fakeDef("echo", async (args) => {
        seen.push(args.value)
        return `echo:${args.value}`
      }),
    ]
    const result = await runToolScript(
      `
      const items = ["a", "b", "c"]
      const outs = await Promise.all(items.map(v => tools.echo({ value: v })))
      return outs.map(o => o.output)
      `,
      defs,
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("echo:a")
    expect(result.output).toContain("echo:c")
    expect(seen.toSorted()).toEqual(["a", "b", "c"])
    expect(result.metadata.toolCalls).toBe(3)
  })

  test("terminal metadata keeps the per-tool counts breakdown", async () => {
    const defs = [
      fakeDef("echo", async (args) => `echo:${args.value}`),
      fakeDef("boom", async () => {
        throw new Error("kapow")
      }),
    ]
    const result = await runToolScript(
      `
      await tools.echo({ value: "a" })
      await tools.echo({ value: "b" })
      try { await tools.boom({}) } catch {}
      return "done"
      `,
      defs,
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.metadata.counts).toEqual({
      echo: { n: 2, errors: 0 },
      boom: { n: 1, errors: 1 },
    })
  })

  test("accepts TypeScript syntax (types stripped by transpiler)", async () => {
    const result = await runToolScript(
      `
      const double = (n: number): number => n * 2
      const xs: number[] = [1, 2, 3]
      return xs.map(double)
      `,
      [],
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("[\n  2,\n  4,\n  6\n]")
  })

  test("console.log is captured into live output", async () => {
    const result = await runToolScript(`console.log("hello", { a: 1 }); return 1`, [])
    expect(result.output).toContain('hello {"a":1}')
  })

  test("unknown tool rejects catchably; trace records the error", async () => {
    const result = await runToolScript(
      `
      try { await tools.nope({}) } catch (e) { return "caught: " + e.message }
      `,
      [],
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("caught:")
    expect(result.output).toContain("unknown tool: nope")
  })

  test("tool failure rejects the guest promise with tool name prefix", async () => {
    const defs = [
      fakeDef("boom", async () => {
        throw new Error("kapow")
      }),
    ]
    const result = await runToolScript(
      `try { await tools.boom({}) } catch (e) { return e.message }`,
      defs,
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("boom: kapow")
    expect(result.output).toContain("→ error")
  })

  test("call budget exceeded → budget_exceeded status", async () => {
    const defs = [fakeDef("ping", async () => "pong")]
    const result = await runToolScript(
      `
      for (let i = 0; i < 60; i++) await tools.ping({})
      return "done"
      `,
      defs,
    )
    expect(result.metadata.status).toBe("budget_exceeded")
  })

  test("max_tool_calls raises the call budget", async () => {
    const defs = [fakeDef("ping", async () => "pong")]
    const result = await runToolScript(
      `
      for (let i = 0; i < 60; i++) await tools.ping({})
      return "done"
      `,
      defs,
      undefined,
      { maxToolCalls: 80 },
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.metadata.toolCalls).toBe(60)
  })

  test("max_tool_calls lowers the call budget and the error names the limit", async () => {
    const defs = [fakeDef("ping", async () => "pong")]
    const result = await runToolScript(
      `
      for (let i = 0; i < 10; i++) await tools.ping({})
      return "done"
      `,
      defs,
      undefined,
      { maxToolCalls: 5 },
    )
    expect(result.metadata.status).toBe("budget_exceeded")
    expect(result.output).toContain("tool call budget exceeded (5 per execution)")
  })

  test("timeout bounds compute time in milliseconds and the error names the budget", async () => {
    const result = await runToolScript(`while (true) {}`, [], undefined, { timeoutMs: 100 })
    expect(result.metadata.status).toBe("timeout")
    expect(result.output).toContain("100ms of active compute")
    expect(result.output).toContain("raise via timeout")
  }, 15_000)

  test("syntax error → code_error", async () => {
    const result = await runToolScript(`const = broken (`, [])
    expect(result.metadata.status).toBe("code_error")
  })

  test("pre-aborted signal cancels the execution", async () => {
    // A sync spin blocks the host event loop, so a timer-armed abort can never
    // fire mid-spin (the 60s active budget covers that in production). An
    // already-aborted signal exercises the interrupt path deterministically.
    const abort = new AbortController()
    abort.abort()
    const result = await runToolScript(`while (true) {}`, [], abort.signal)
    expect(result.metadata.status).toBe("cancelled")
  }, 15_000)

  test("internal tools are excluded while Codex control-flow tools remain dispatchable", async () => {
    const defs = [
      fakeDef("task", async () => "task ran"),
      fakeDef("mcp_tool_search", async () => "should never run"),
    ]
    const result = await runToolScript(
      `const task = await tools.task({});
       const listed = ALL_TOOLS.some((tool) => tool.name === "mcp_tool_search");
       try { await tools.mcp_tool_search({ query: "docs" }) } catch (e) { return { task: task.output, listed, error: e.message } }`,
      defs,
    )
    expect(result.output).toContain('"task": "task ran"')
    expect(result.output).toContain('"listed": false')
    expect(result.output).toContain("unknown tool: mcp_tool_search")
  })

  test("bash and exec_command dispatch through the same tool definition", async () => {
    const seen: string[] = []
    const defs = [
      fakeDef("bash", async (args) => {
        seen.push(args.value)
        return `ran:${args.value}`
      }),
    ]
    const result = await runToolScript(
      `return await Promise.all([
        tools.bash({ value: "direct" }),
        tools.exec_command({ value: "alias" }),
      ])`,
      defs,
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.metadata.toolCalls).toBe(2)
    expect(result.output).toContain("ran:direct")
    expect(result.output).toContain("ran:alias")
    expect(seen.toSorted()).toEqual(["alias", "direct"])
  })

  test("an exec_command-only runtime whitelist authorizes its bash target", async () => {
    const result = await runToolScript(
      `return await tools.exec_command({ value: "allowed" })`,
      [fakeDef("bash", async (args) => `ran:${args.value}`)],
      undefined,
      { toolWhitelist: ["exec_command"] },
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("ran:allowed")
  })

  test("apply_patch uses the Codex freeform string declaration and dispatch shape", async () => {
    let seen: unknown
    const defs = [
      fakeDef("apply_patch", async (args) => {
        seen = args
        return "done"
      }),
    ]
    const result = await runToolScript(`return await tools.apply_patch("*** Begin Patch")`, defs)
    const description = renderToolScriptDeclarations(defs)

    expect(description).toContain("apply_patch(input: string)")
    expect(result.metadata.status).toBe("completed")
    expect(seen).toEqual({ patch_text: "*** Begin Patch" })
  })

  test("supports parallel bash calls with millisecond timeouts", async () => {
    const seen: Array<{ command: string; timeout?: number }> = []
    const parameters = z.object({
      command: z.string(),
      description: z.string(),
      workdir: z.string().optional(),
      timeout: z.number().optional(),
    })
    const bash: Tool.Def<typeof parameters> = {
      id: "bash",
      description: "Runs a command with a timeout measured in milliseconds.",
      parameters,
      execute: (args) => {
        seen.push({ command: args.command, timeout: args.timeout })
        return Effect.succeed({ title: args.description, output: args.command, metadata: { timeout: args.timeout } })
      },
    }
    const result = await runToolScript(
      `const results = await Promise.allSettled([
        tools.bash({ command: "git status --short --branch && git diff --check", description: "Confirm branch state and check diff whitespace", timeout: 120000 }),
        tools.bash({ command: "bun test --timeout 30000", workdir: ${JSON.stringify(tmp)}, description: "Run the complete opencode test suite", timeout: 600000 }),
        tools.bash({ command: "bun typecheck", workdir: ${JSON.stringify(tmp)}, description: "Run opencode TypeScript checks", timeout: 600000 }),
      ]);
      return results.map((x, i) => x.status === "fulfilled"
        ? { index: i, output: x.value.output, metadata: x.value.metadata }
        : { index: i, error: String(x.reason) });`,
      [bash],
    )

    expect(result.metadata.status).toBe("completed")
    expect(result.metadata.toolCalls).toBe(3)
    expect(seen.map((item) => item.timeout).toSorted()).toEqual([120_000, 600_000, 600_000])
    expect(result.output).toContain('"index": 2')
    expect(result.output).toContain('"timeout": 600000')
  })

  test("concurrency is capped at 8", async () => {
    let active = 0
    let peak = 0
    const defs = [
      fakeDef("work", async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return "ok"
      }),
    ]
    const result = await runToolScript(
      `
      await Promise.all(Array.from({ length: 20 }, () => tools.work({})))
      return "done"
      `,
      defs,
    )
    expect(result.metadata.status).toBe("completed")
    expect(peak).toBeLessThanOrEqual(8)
    expect(peak).toBeGreaterThan(1)
  })

  test("Date works inside exec guest", async () => {
    const result = await runToolScript(`return typeof Date.now()`, [])
    expect(result.output).toContain("number")
  })

  test("files.writeText → files.readText round-trips raw bytes via tmp", async () => {
    const marker = `ts-${Date.now()}`
    const write = await runToolScript(
      `
      await files.writeText("${path.join(os.tmpdir(), marker)}.json", JSON.stringify({ a: [1, 2], s: "x: 1" }))
      return "written"
      `,
      [],
    )
    expect(write.metadata.status).toBe("completed")
    const read = await runToolScript(
      `
      const data = JSON.parse(await files.readText("${path.join(os.tmpdir(), marker)}.json"))
      return data.a.length + ":" + data.s
      `,
      [],
    )
    expect(read.metadata.status).toBe("completed")
    expect(read.output).toContain("2:x: 1")
    await fs.rm(path.join(os.tmpdir(), `${marker}.json`), { force: true })
  })

  test("files.readText returns null for missing file", async () => {
    const result = await runToolScript(
      `return (await files.readText("${path.join(os.tmpdir(), "definitely-missing-xyz.json")}")) === null`,
      [],
    )
    expect(result.output).toContain("true")
  })

  test("files.readText rejects paths outside jail (catchable)", async () => {
    const result = await runToolScript(
      `try { await files.readText("/etc/passwd") } catch (e) { return e.message }`,
      [],
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("outside allowed roots")
  })

  test("files.writeText rejects paths outside the OS tmp dir (write is tmp-only)", async () => {
    // NOTE: the test worktree lives INSIDE os.tmpdir() (mkdtemp), so a worktree
    // path can't exercise the rejection here — use a clearly-outside path.
    const result = await runToolScript(
      `try { await files.writeText("/etc/tool-script-test.json", "data") } catch (e) { return e.message }`,
      [],
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("tools.apply_patch")
  })

  test("files.readText reads worktree files raw (no line numbers)", async () => {
    await fs.writeFile(path.join(tmp, "raw-check.json"), `{"k": "1: not a line number"}`)
    const result = await runToolScript(
      `
      const data = JSON.parse(await files.readText("raw-check.json"))
      return data.k
      `,
      [],
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("1: not a line number")
  })

  test("circular reference in return value fails loud with the offending path", async () => {
    const result = await runToolScript(`const a = { items: [{}] }; a.items[0].self = a; return a`, [])
    expect(result.metadata.status).toBe("code_error")
    expect(result.output).toContain("circular reference at $.items[0].self")
  })

  test("BigInt fails loud with path and conversion hint (top-level and nested)", async () => {
    const top = await runToolScript(`return 123n`, [])
    expect(top.metadata.status).toBe("code_error")
    expect(top.output).toContain("BigInt at $")
    const nested = await runToolScript(`return { x: { y: 123n } }`, [])
    expect(nested.metadata.status).toBe("code_error")
    expect(nested.output).toContain("BigInt at $.x.y")
  })

  test("throwing getter fails loud with path", async () => {
    const result = await runToolScript(`return { get x() { throw new Error("boom") } }`, [])
    expect(result.metadata.status).toBe("code_error")
    expect(result.output).toContain("getter at $.x threw: boom")
  })

  test("lossy conversions succeed with warnings: NaN, Map, Set, Error, RegExp", async () => {
    const result = await runToolScript(
      `return { n: NaN, m: new Map([["k", 1]]), s: new Set([2]), e: new Error("msg"), r: /x/g }`,
      [],
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("<warnings>")
    expect(result.output).toContain("NaN at $.n serialized as null")
    expect(result.output).toContain('"m": [')
    expect(result.output).toContain('"message": "msg"')
    expect(result.output).not.toContain('"stack"')
    expect(result.output).toContain('"r": "/x/g"')
  })

  test("clean JSON return has no warnings block", async () => {
    const result = await runToolScript(`return { a: 1, b: "x", c: [true, null] }`, [])
    expect(result.metadata.status).toBe("completed")
    expect(result.output).not.toContain("<warnings>")
  })

  test("console.log renders circular objects and Errors usefully", async () => {
    const result = await runToolScript(
      `const a = {}; a.self = a; console.log(a); console.log(new Error("oops")); return "done"`,
      [],
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain('{"self":"[Circular]"}')
    expect(result.output).toContain("oops")
  })

  test("string return passes through verbatim (no JSON escaping)", async () => {
    const result = await runToolScript(`return "line1\\nline2 with \\"quotes\\""`, [])
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain('line1\nline2 with "quotes"')
    expect(result.output).not.toContain("<return_value>")
  })

  test("syntax error reports line, column, and source line", async () => {
    const result = await runToolScript(`const ok = 1\nconst = broken (`, [])
    expect(result.metadata.status).toBe("code_error")
    expect(result.output).toContain("line 2, column 7")
    expect(result.output).toContain("const = broken (")
  })

  test("top-level import gets an explicit not-supported note", async () => {
    const result = await runToolScript(`import * as x from "node:fs"\nreturn 1`, [])
    expect(result.metadata.status).toBe("code_error")
    expect(result.output).toContain("import/export are NOT supported")
  })

  test("files: literal /tmp paths work (macOS symlink jail)", async () => {
    const marker = path.join("/tmp", `ts-jail-${Date.now()}.json`)
    const result = await runToolScript(
      `
      await files.writeText("${marker}", "via-tmp")
      return await files.readText("${marker}")
      `,
      [],
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("via-tmp")
    await fs.rm(marker, { force: true })
  })

  test("files.readText rejects binary (non-UTF-8) files instead of returning empty", async () => {
    const bin = path.join(os.tmpdir(), `ts-bin-${Date.now()}.dat`)
    await fs.writeFile(bin, new Uint8Array([0x00, 0xff, 0xfe, 0x41, 0x80]))
    const result = await runToolScript(
      `try { await files.readText("${bin}"); return "no-error" } catch (e) { return "caught: " + e.message }`,
      [],
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("caught:")
    expect(result.output).toContain("not valid UTF-8")
    await fs.rm(bin, { force: true })
  })

  test("strings containing NUL survive the host→guest marshal boundary", async () => {
    const nulFile = path.join(os.tmpdir(), `ts-nul-${Date.now()}.txt`)
    // Valid UTF-8 containing a NUL byte — legal text, previously truncated at \0.
    await fs.writeFile(nulFile, "before\0after")
    const result = await runToolScript(
      `const v = await files.readText("${nulFile}"); return { len: v.length, tail: v.slice(7) }`,
      [],
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain('"len": 12')
    expect(result.output).toContain('"tail": "after"')
    await fs.rm(nulFile, { force: true })
  })

  test("discovers an MCP tool through ALL_TOOLS and dispatches its exact name", async () => {
    const result = await runToolScript(
      `const match = ALL_TOOLS.find((tool) => tool.name.includes("browser") && tool.name.includes("navigate"));
       if (!match) return "not found";
       const navigation = await tools[match.name]({ url: "https://example.com" });
       return navigation.output`,
      [],
      undefined,
      {
        mcp: {
          mcp__chrome_devtools__browser_navigate: {
            description: "Navigate a browser page to a URL",
            inputSchema: z.object({ url: z.string() }),
            execute: async (args: { url: string }) => ({
              output: `navigated: ${args.url}`,
              metadata: { mcp: { isError: false } },
              attachments: [],
            }),
          },
        },
      },
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("navigated: https://example.com")
  })
})

describe("renderToolScriptDeclarations", () => {
  test("renders TS signatures and skips excluded tools", () => {
    const defs = [
      fakeDef("read", async () => "x"),
      fakeDef("mcp_tool_search", async () => "x"),
      fakeDef("task", async () => "x"),
      fakeDef("question", async () => "x"),
    ]
    const text = renderToolScriptDeclarations(defs)
    expect(text).toContain("read(args:")
    expect(text).not.toContain("mcp_tool_search(args:")
    expect(text).toContain("task(args:")
    expect(text).toContain("question(args:")
    expect(text).toContain("declare const tools")
  })

  test("not-callable set covers recursive and internal tools but allows Codex nested tools", () => {
    for (const id of ["exec", "wait", "mcp_tool_search", "invalid", "session", "workflow"]) {
      expect(NOT_CALLABLE_IN_EXEC.has(id)).toBe(true)
    }
    for (const id of ["bash", "task", "question", "actor", "skill", "plan_exit", "cron", "change_directory"]) {
      expect(NOT_CALLABLE_IN_EXEC.has(id)).toBe(false)
    }
  })

  test("renders exec_command as an alias for bash", () => {
    const text = renderToolScriptDeclarations([fakeDef("bash", async () => "x")])
    expect(text).toContain("bash(args:")
    expect(text).toContain("exec_command(args:")
    expect(text).toContain("Alias for bash")
  })

  test("renders schema property descriptions as TypeScript comments", () => {
    const parameters = z.object({ query: z.string().describe("Search terms supplied by the user") })
    const def: Tool.Def<typeof parameters> = {
      id: "search",
      description: "Search",
      parameters,
      execute: () => Effect.succeed({ title: "", output: "", metadata: {} }),
    }
    expect(renderToolScriptDeclarations([def])).toContain("// Search terms supplied by the user")
  })

  test("renders the shared MCP preamble once and preserves structured output types", async () => {
    const declarations = await renderMcpToolScriptDeclarations({
      mcp__sample__search: {
        description: "Search structured records",
        inputSchema: z.object({ query: z.string().describe("Query sent to the MCP server") }),
        outputSchema: z.object({
          content: z.array(z.object({ type: z.string() })),
          isError: z.boolean(),
          _meta: z.record(z.string(), z.unknown()),
          structuredContent: z.object({
            results: z.array(z.object({ id: z.string() })).describe("Structured search hits"),
          }),
        }),
        execute: async () => ({ content: [], isError: false, _meta: {}, structuredContent: { results: [] } }),
      },
    })
    expect(declarations.match(/Shared MCP Types:/g)).toHaveLength(1)
    expect(declarations).toContain("type CallToolResult")
    expect(declarations).toContain("Promise<CallToolResult<")
    expect(declarations).toContain("// Query sent to the MCP server")
    expect(declarations).toContain("// Structured search hits")
  })

})

describe("exec MCP dispatch", () => {
  // Mimics the SessionPrompt-wrapped MCP execute: resolves with the normalized
  // {output, metadata, attachments} shape (permission/hooks/truncation already
  // applied by the wrapper), rejects on tool failure.
  function fakeMcpTool(execute: (args: any) => Promise<any>) {
    return {
      description: "fake mcp tool",
      inputSchema: z.object({}),
      execute,
    }
  }

  test("MCP tool is callable and returns output text", async () => {
    const mcp = {
      srv_search: fakeMcpTool(async (args) => ({
        output: `found: ${args.query}`,
        metadata: { mcp: { isError: false } },
        attachments: [],
      })),
    }
    const result = await runToolScript(
      `const r = await tools.srv_search({ query: "hello" }); return r.output`,
      [],
      undefined,
      { mcp },
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("found: hello")
  })

  test("structuredContent crosses into the guest as parsed `structured`", async () => {
    const mcp = {
      srv_data: fakeMcpTool(async () => ({
        output: "3 items",
        metadata: { mcp: { isError: false, structuredContent: { items: [1, 2, 3], total: 3 } } },
        attachments: [],
      })),
    }
    const result = await runToolScript(
      `const r = await tools.srv_data({});
       return { total: r.structured.total, doubled: r.structured.items.map((x) => x * 2) }`,
      [],
      undefined,
      { mcp },
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain('"total": 3')
    expect(result.output).toContain("4")
    expect(result.output).toContain("6")
  })

  test("MCP failure rejects catchably inside the guest", async () => {
    const mcp = {
      srv_fail: fakeMcpTool(async () => {
        throw new Error("server exploded")
      }),
    }
    const result = await runToolScript(
      `try { await tools.srv_fail({}) } catch (e) { return "caught: " + e.message }`,
      [],
      undefined,
      { mcp },
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("caught: srv_fail: server exploded")
  })

  test("builtin id wins on collision with an MCP tool", async () => {
    const mcp = {
      echo: fakeMcpTool(async () => ({ output: "mcp version", metadata: {}, attachments: [] })),
    }
    const result = await runToolScript(
      `const r = await tools.echo({ value: "x" }); return r.output`,
      [fakeDef("echo", async () => "builtin version")],
      undefined,
      { mcp },
    )
    expect(result.output).toContain("builtin version")
  })

  test("reserved aliases cannot be shadowed by MCP tools", async () => {
    const mcp = {
      exec_command: fakeMcpTool(async () => ({ output: "mcp version", metadata: {}, attachments: [] })),
    }
    const result = await runToolScript(
      `const listed = ALL_TOOLS.some((tool) => tool.name === "exec_command");
       try { await tools.exec_command({}) } catch (e) { return { listed, error: e.message } }`,
      [],
      undefined,
      { mcp },
    )
    expect(result.output).toContain('"listed": false')
    expect(result.output).toContain("unknown tool: exec_command")
    expect(result.output).not.toContain("mcp version")
  })

  test("attachments are dropped with a note", async () => {
    const mcp = {
      srv_img: fakeMcpTool(async () => ({
        output: "here is your chart",
        metadata: { mcp: { isError: false } },
        attachments: [{ mime: "image/png", url: "data:image/png;base64,xxxx" }],
      })),
    }
    const result = await runToolScript(
      `const r = await tools.srv_img({}); return r.output`,
      [],
      undefined,
      { mcp },
    )
    expect(result.output).toContain("here is your chart")
    expect(result.output).toContain("non-text attachment(s) dropped")
  })

  test("MCP calls count against the tool call budget", async () => {
    const mcp = {
      srv_a: fakeMcpTool(async () => ({ output: "a", metadata: {}, attachments: [] })),
    }
    const result = await runToolScript(
      `for (let i = 0; i < 3; i++) await tools.srv_a({}); return "done"`,
      [],
      undefined,
      { mcp, maxToolCalls: 2 },
    )
    expect(result.metadata.status).not.toBe("completed")
    expect(result.output).toContain("budget exceeded")
  })

  test("whitelist filters MCP tools too", async () => {
    const mcp = {
      srv_blocked: fakeMcpTool(async () => ({ output: "should not run", metadata: {}, attachments: [] })),
    }
    const result = await runToolScript(
      `try { await tools.srv_blocked({}) } catch (e) { return "denied: " + e.message }`,
      [],
      undefined,
      { mcp, toolWhitelist: ["exec"] },
    )
    expect(result.output).toContain("denied:")
    expect(result.output).toContain("unknown tool")
  })
})
