import { describe, expect, test, afterAll } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import z from "zod"
import os from "os"
import fs from "fs/promises"
import path from "path"
import { evalScript } from "../../src/workflow/sandbox"
import { jsonSchema } from "ai"
import { Agent } from "../../src/agent/agent"
import { Truncate, Tool } from "../../src/tool"
import { ToolScriptTool, renderToolScriptDeclarations } from "../../src/tool/tool-script"
import { toolScriptRegistry, toolScriptMcp, TOOL_SCRIPT_EXCLUDED } from "../../src/tool/tool-script-ref"
import { Instance } from "../../src/project/instance"

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
  opts?: { mcp?: Record<string, any>; ask?: () => Effect.Effect<void>; maxToolCalls?: number; timeoutSeconds?: number },
) {
  const prev = toolScriptRegistry.current
  const prevMcp = toolScriptMcp.current
  toolScriptRegistry.current = () => Effect.succeed(defs)
  toolScriptMcp.current = opts?.mcp ? () => Effect.succeed(opts.mcp!) : undefined
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
              ...(opts?.timeoutSeconds !== undefined && { timeout_seconds: opts.timeoutSeconds }),
            },
            {
              sessionID: "ses_test" as any,
              messageID: "msg_test" as any,
              agent: "build",
              abort: abort ?? new AbortController().signal,
              callID: "call_test",
              messages: [],
              metadata: () => Effect.void,
              ask: opts?.ask ?? (() => Effect.void),
            },
          ),
        )
      },
    })
  } finally {
    toolScriptRegistry.current = prev
    toolScriptMcp.current = prevMcp
  }
}

describe("tool_script", () => {
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

  test("console.log is captured into Logs block", async () => {
    const result = await runToolScript(`console.log("hello", { a: 1 }); return 1`, [])
    expect(result.output).toContain("<logs>")
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

  test("timeout_seconds bounds compute time and the error names the budget", async () => {
    const result = await runToolScript(`while (true) {}`, [], undefined, { timeoutSeconds: 1 })
    expect(result.metadata.status).toBe("timeout")
    expect(result.output).toContain("1s of active compute")
    expect(result.output).toContain("timeout_seconds")
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

  test("excluded tools are not dispatchable", async () => {
    const defs = [fakeDef("task", async () => "should never run")]
    const result = await runToolScript(
      `try { await tools.task({}) } catch (e) { return e.message }`,
      defs,
    )
    expect(result.output).toContain("unknown tool: task")
  })

  test("bash is excluded from the sandbox", async () => {
    const defs = [fakeDef("bash", async () => "should never run")]
    const result = await runToolScript(
      `try { await tools.bash({ value: "ls" }) } catch (e) { return e.message }`,
      defs,
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("unknown tool: bash")
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

  test("Date works inside tool_script guest", async () => {
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
    expect(result.output).toContain("tools.write/tools.edit")
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
})

describe("tool_script MCP dispatch", () => {
  function fakeMcpTool(execute: (args: any) => Promise<any>) {
    return {
      description: "fake mcp tool",
      inputSchema: jsonSchema({ type: "object", properties: { q: { type: "string" } } }),
      execute,
    }
  }

  test("MCP tool is callable; result content folds to text output", async () => {
    const seen: any[] = []
    const mcp = {
      srv_search: fakeMcpTool(async (args) => {
        seen.push(args)
        return { content: [{ type: "text", text: "hit-1" }, { type: "text", text: "hit-2" }] }
      }),
    }
    const result = await runToolScript(
      `const r = await tools.srv_search({ q: "x" }); return r.output`,
      [],
      undefined,
      { mcp },
    )
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("hit-1")
    expect(result.output).toContain("hit-2")
    expect(seen).toEqual([{ q: "x" }])
  })

  test("MCP call goes through permission ask", async () => {
    const asked: string[] = []
    const mcp = {
      srv_go: fakeMcpTool(async () => ({ content: [{ type: "text", text: "ok" }] })),
    }
    const result = await runToolScript(`return (await tools.srv_go({})).output`, [], undefined, {
      mcp,
      ask: () => {
        asked.push("srv_go")
        return Effect.void
      },
    })
    expect(result.metadata.status).toBe("completed")
    expect(asked).toContain("srv_go")
  })

  test("MCP isError result rejects catchably", async () => {
    const mcp = {
      srv_fail: fakeMcpTool(async () => ({
        isError: true,
        content: [{ type: "text", text: "server exploded" }],
      })),
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

  test("non-text MCP content is dropped with a note", async () => {
    const mcp = {
      srv_img: fakeMcpTool(async () => ({
        content: [
          { type: "text", text: "caption" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ],
      })),
    }
    const result = await runToolScript(`return (await tools.srv_img({})).output`, [], undefined, { mcp })
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("caption")
    expect(result.output).toContain("non-text attachment(s) dropped")
  })

  test("builtin tool id wins over a colliding MCP tool id", async () => {
    const defs = [fakeDef("echo", async (args) => `builtin:${args.value}`)]
    const mcp = {
      echo: fakeMcpTool(async () => ({ content: [{ type: "text", text: "mcp-should-not-run" }] })),
    }
    const result = await runToolScript(`return (await tools.echo({ value: "v" })).output`, defs, undefined, { mcp })
    expect(result.metadata.status).toBe("completed")
    expect(result.output).toContain("builtin:v")
    expect(result.output).not.toContain("mcp-should-not-run")
  })

  test("MCP calls count against the shared 50-call budget", async () => {
    const mcp = {
      srv_ping: fakeMcpTool(async () => ({ content: [{ type: "text", text: "pong" }] })),
    }
    const result = await runToolScript(
      `for (let i = 0; i < 60; i++) await tools.srv_ping({}); return "done"`,
      [],
      undefined,
      { mcp },
    )
    expect(result.metadata.status).toBe("budget_exceeded")
  })
})

describe("renderToolScriptDeclarations", () => {
  test("renders TS signatures and skips excluded tools", () => {
    const defs = [
      fakeDef("read", async () => "x"),
      fakeDef("task", async () => "x"),
      fakeDef("question", async () => "x"),
    ]
    const text = renderToolScriptDeclarations(defs)
    expect(text).toContain("read(input:")
    expect(text).not.toContain("task(input:")
    expect(text).not.toContain("question(input:")
    expect(text).toContain("declare const tools")
  })

  test("exclusion list covers agent control-flow tools and bash", () => {
    for (const id of ["task", "question", "actor", "skill", "plan_enter", "plan_exit", "tool_script", "bash"]) {
      expect(TOOL_SCRIPT_EXCLUDED.has(id)).toBe(true)
    }
  })

  test("MCP tools are rendered into the declaration block", () => {
    const mcp = {
      srv_search: {
        description: "Search the thing",
        inputSchema: jsonSchema({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }),
        execute: async () => ({ content: [] }),
      },
    }
    const text = renderToolScriptDeclarations([fakeDef("read", async () => "x")], mcp as any)
    expect(text).toContain("srv_search(input: { q: string })")
    expect(text).toContain("[MCP] Search the thing")
  })
})
