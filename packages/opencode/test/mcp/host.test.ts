// [TP-MCU-R7-21] Desktop computer-use: retired host connections follow request/turn lifetimes.
import { test, expect } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { unlink } from "node:fs/promises"
import { Effect, Fiber } from "effect"
import { MCP } from "../../src/mcp"
import { ObservingStdioTransport } from "../../src/mcp/stdio-transport"
import { HostMcp } from "../../src/mcp/host"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

async function fixture() {
  return tmpdir({
    init: async (dir) => {
      const script = `${dir}/server.mjs`
      await Bun.write(
        script,
        `
      import readline from 'node:readline';
      import fs from 'node:fs';
      const lines = readline.createInterface({ input: process.stdin });
      lines.on('close', () => process.exit(0));
      lines.on('line', async line => {
        const req = JSON.parse(line);
        if (req.method === 'notifications/com.xiaomi.mimo/turn-lifecycle') {
          fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({label: process.env.FIXTURE_LABEL, ...req.params}) + '\\n');
        }
        if (req.id == null) return;
        const args = req.params?.arguments ?? {};
        if (req.method === 'tools/call') {
          if (args.started) fs.writeFileSync(args.started, 'started');
          if (args.gate) while (!fs.existsSync(args.gate)) await new Promise(resolve => setTimeout(resolve, 10));
          else await new Promise(resolve => setTimeout(resolve, 150));
        }
        const result = req.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {tools: {}, resources: {}, prompts: {}, experimental: {'com.xiaomi.mimo/turn-lifecycle': {version: 1}}}, serverInfo: {name: 'fixture', version: '1'} }
          : req.method === 'tools/list'
          ? { tools: [{name: 'read', inputSchema: {type: 'object'}}] }
          : req.method === 'resources/list'
          ? {resources: [{name: process.env.FIXTURE_LABEL, uri: 'fixture://value'}]}
          : req.method === 'resources/read'
          ? {contents: [{uri: 'fixture://value', text: process.env.FIXTURE_LABEL}]}
          : req.method === 'prompts/list'
          ? {prompts: [{name: process.env.FIXTURE_LABEL}]}
          : req.method === 'prompts/get'
          ? {messages: [{role: 'user', content: {type: 'text', text: process.env.FIXTURE_LABEL}}]}
          : { content: [{type: 'text', text: process.env.FIXTURE_LABEL}] };
        process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: req.id, ...(args.fail ? {error: {code: -32603, message: 'fixture failure'}} : {result})}) + '\\n');
      });
    `,
      )
      return {
        log: `${dir}/lifecycle.jsonl`,
        config: (label: string, enabled = true) => ({
          type: "local" as const,
          command: [process.execPath, script],
          enabled,
          environment: { FIXTURE_LABEL: label, FIXTURE_LOG: `${dir}/lifecycle.jsonl` },
        }),
      }
    },
  })
}

function observeClose(client: Client) {
  const transport = client.transport
  let closed = false
  const done = Promise.withResolvers<void>()
  client.onclose = () => {
    closed = true
    done.resolve()
  }
  return {
    done: done.promise,
    isClosed: () => closed,
    pid: transport instanceof ObservingStdioTransport ? transport.pid : null,
  }
}

async function waitForFile(file: string) {
  for (let i = 0; i < 500; i++) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(10)
  }
  throw new Error("fixture request did not start")
}

test("host readiness refreshes a cached instance while other MCP calls continue", async () => {
  await using tmp = await fixture()
  const config = tmp.extra.config
  await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify({ mcp: { other: config("other") } }))
  HostMcp.set({ automation: config("first", false) })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(
          MCP.Service.use((mcp) =>
            Effect.gen(function* () {
              expect(Object.keys(yield* mcp.tools())).toEqual(["other_read"])
              const other = (yield* mcp.clients()).other
              const pending = other.callTool({ name: "read", arguments: {} })
              HostMcp.set({ automation: config("first") })
              const discoveries = yield* Effect.all([mcp.tools(), mcp.tools()], { concurrency: "unbounded" })
              expect(discoveries.every((tools) => "automation_read" in tools)).toBe(true)
              expect((yield* mcp.clients()).other).toBe(other)
              expect((yield* Effect.promise(() => pending)).content).toEqual([{ type: "text", text: "other" }])
              const first = (yield* mcp.clients()).automation
              const inFlight = first.callTool({ name: "read", arguments: {} })
              HostMcp.set({ automation: config("second") })
              yield* mcp.tools()
              expect((yield* mcp.clients()).automation).not.toBe(first)
              expect((yield* Effect.promise(() => inFlight)).content).toEqual([{ type: "text", text: "first" }])
              HostMcp.set({ automation: config("second", false) })
              expect(Object.keys(yield* mcp.tools())).toEqual(["other_read"])
              HostMcp.set({ automation: config("third"), other: config("override") })
              expect(Object.keys(yield* mcp.tools()).sort()).toEqual(["automation_read", "other_read"])
              HostMcp.set({})
              expect(Object.keys(yield* mcp.tools())).toEqual(["other_read"])
              const restored = (yield* mcp.clients()).other
              expect((yield* Effect.promise(() => restored.callTool({ name: "read", arguments: {} }))).content).toEqual(
                [{ type: "text", text: "other" }],
              )
            }),
          ).pipe(Effect.provide(MCP.defaultLayer)),
        )
        await Instance.dispose()
      },
    })
  } finally {
    HostMcp.set({})
  }
}, 20_000)

for (const outcome of ["completed", "error", "cancelled"] as const) {
  test(`retired connection exits after an in-flight request is ${outcome}`, async () => {
    await using tmp = await fixture()
    HostMcp.set({ automation: tmp.extra.config("first") })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          try {
            await Effect.runPromise(
              MCP.Service.use((mcp) =>
                Effect.gen(function* () {
                  const first = (yield* mcp.clients()).automation
                  const close = observeClose(first)
                  const abort = new AbortController()
                  const pending = first
                    .callTool(
                      {
                        name: "read",
                        arguments: {
                          started: `${tmp.path}/started`,
                          gate: `${tmp.path}/gate`,
                          fail: outcome === "error",
                        },
                      },
                      undefined,
                      { signal: abort.signal },
                    )
                    .then(
                      (value) => ({ value, error: undefined }),
                      (error: unknown) => ({ value: undefined, error }),
                    )
                  yield* Effect.promise(() => waitForFile(`${tmp.path}/started`))
                  HostMcp.set({ automation: tmp.extra.config("second") })
                  const current = (yield* mcp.clients()).automation
                  expect(current).not.toBe(first)
                  expect(close.isClosed()).toBe(false)
                  if (outcome === "cancelled") abort.abort(new Error("cancelled"))
                  else yield* Effect.promise(() => Bun.write(`${tmp.path}/gate`, "go"))
                  const result = yield* Effect.promise(() => pending)
                  if (outcome === "completed") expect(result.value?.content).toEqual([{ type: "text", text: "first" }])
                  else expect(result.error).toBeDefined()
                  yield* Effect.promise(() => close.done)
                  expect(close.isClosed()).toBe(true)
                  expect(close.pid).not.toBeNull()
                  expect(() => process.kill(close.pid!, 0)).toThrow()
                  expect(
                    (yield* Effect.promise(() => current.callTool({ name: "read", arguments: {} }))).content,
                  ).toEqual([{ type: "text", text: "second" }])
                  const currentClose = observeClose(current)
                  HostMcp.set({ automation: tmp.extra.config("second", false) })
                  expect(Object.keys(yield* mcp.tools())).toEqual([])
                  yield* Effect.promise(() => currentClose.done)
                }),
              ).pipe(Effect.provide(MCP.defaultLayer)),
            )
          } finally {
            await Instance.dispose()
          }
        },
      })
    } finally {
      HostMcp.set({})
    }
  }, 20_000)
}

test("turn bindings retain delayed calls and notify every used generation before release", async () => {
  await using tmp = await fixture()
  HostMcp.set({ automation: tmp.extra.config("first") })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          await Effect.runPromise(
            MCP.Service.use((mcp) =>
              Effect.gen(function* () {
                const context = { sessionId: "ses_example", turnId: "turn_example" }
                const concurrent = { sessionId: "ses_other", turnId: "turn_other" }
                const oldTools = yield* mcp.tools(context)
                yield* mcp.tools(concurrent)
                const first = (yield* mcp.clients()).automation
                const firstClose = observeClose(first)
                HostMcp.set({ automation: tmp.extra.config("second") })
                yield* mcp.tools(context)
                const second = (yield* mcp.clients()).automation
                const secondClose = observeClose(second)
                expect(firstClose.isClosed()).toBe(false)
                const result = yield* Effect.promise(() =>
                  Promise.resolve(
                    oldTools.automation_read.execute!(
                      {},
                      { toolCallId: "call_example", messages: [], abortSignal: new AbortController().signal },
                    ),
                  ),
                )
                expect(result).toMatchObject({ content: [{ type: "text", text: "first" }] })
                HostMcp.set({ automation: tmp.extra.config("second", false) })
                expect(Object.keys(yield* mcp.tools())).toEqual([])
                yield* MCP.notifyTurnLifecycle(yield* mcp.clients(context), context, "completed")
                yield* Effect.promise(() => secondClose.done)
                expect(firstClose.isClosed()).toBe(false)
                yield* MCP.notifyTurnLifecycle(yield* mcp.clients(concurrent), concurrent, "cancelled")
                yield* Effect.promise(() => firstClose.done)
                expect(yield* mcp.clients(context)).toEqual({})
                const events = (yield* Effect.promise(() => Bun.file(tmp.extra.log).text()))
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line))
                expect(events).toContainEqual({ label: "first", ...context, status: "completed" })
                expect(events).toContainEqual({ label: "second", ...context, status: "completed" })
                expect(events).toContainEqual({ label: "first", ...concurrent, status: "cancelled" })
              }),
            ).pipe(Effect.provide(MCP.defaultLayer)),
          )
        } finally {
          await Instance.dispose()
        }
      },
    })
  } finally {
    HostMcp.set({})
  }
}, 20_000)

test("resource and prompt access refresh host configuration without tool discovery", async () => {
  await using tmp = await fixture()
  HostMcp.set({ automation: tmp.extra.config("first") })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          await Effect.runPromise(
            MCP.Service.use((mcp) =>
              Effect.gen(function* () {
                yield* mcp.clients()
                HostMcp.set({ automation: tmp.extra.config("second") })
                expect(yield* mcp.readResource("automation", "fixture://value")).toMatchObject({
                  contents: [{ text: "second" }],
                })
                HostMcp.set({ automation: tmp.extra.config("third") })
                expect(yield* mcp.getPrompt("automation", "example")).toMatchObject({
                  messages: [{ content: { text: "third" } }],
                })
                HostMcp.set({ automation: tmp.extra.config("fourth") })
                expect(Object.values(yield* mcp.resources()).map((entry) => entry.name)).toEqual(["fourth"])
                HostMcp.set({ automation: tmp.extra.config("fifth") })
                expect(Object.values(yield* mcp.prompts()).map((entry) => entry.name)).toEqual(["fifth"])
              }),
            ).pipe(Effect.provide(MCP.defaultLayer)),
          )
        } finally {
          await Instance.dispose()
        }
      },
    })
  } finally {
    HostMcp.set({})
  }
}, 20_000)

test("host sampling deny overrides a user-config allow for the same server", async () => {
  await using tmp = await fixture()
  const script = `${tmp.path}/sampling-fixture.mjs`
  const samplingLog = `${tmp.path}/sampling.log`
  await Bun.write(
    script,
    `
    import readline from 'node:readline';
    import fs from 'node:fs';
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('close', () => process.exit(0));
    lines.on('line', async line => {
      const msg = JSON.parse(line);
      if (msg.id === 9001 && msg.error) {
        fs.appendFileSync(process.env.SAMPLING_LOG, JSON.stringify(msg.error) + '\\n');
        return;
      }
      if (msg.id == null) return;
      const req = msg;
      if (req.method === 'initialize') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'sampling-fixture',version:'1'}}}) + '\\n');
        return;
      }
      if (req.method === 'tools/list') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{tools:[{name:'read',inputSchema:{type:'object'}}]}}) + '\\n');
        return;
      }
      if (req.method === 'tools/call') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 9001,
          method: 'sampling/createMessage',
          params: {
            messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
            maxTokens: 16,
          },
        }) + '\\n');
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{content:[{type:'text',text:'ok'}]}}) + '\\n');
        return;
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{content:[]}}) + '\\n');
    });
    `,
  )
  const hostEnv = { SAMPLING_LOG: samplingLog }
  await Bun.write(
    `${tmp.path}/mimocode.json`,
    JSON.stringify({
      mcp: {
        automation: {
          type: "local",
          command: [process.execPath, script],
          enabled: true,
          sampling: "allow",
          environment: hostEnv,
        },
      },
    }),
  )
  HostMcp.set({
    automation: {
      type: "local",
      command: [process.execPath, script],
      enabled: true,
      sampling: "deny",
      environment: hostEnv,
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          await Effect.runPromise(
            MCP.Service.use((mcp) =>
              Effect.gen(function* () {
                const client = (yield* mcp.clients()).automation!
                yield* Effect.promise(() => client.callTool({ name: "read", arguments: {} }))
                yield* Effect.promise(() => waitForFile(samplingLog))
                const raw = yield* Effect.promise(() => Bun.file(samplingLog).text())
                expect(raw).toContain("denied")
              }),
            ).pipe(Effect.provide(MCP.defaultLayer)),
          )
        } finally {
          await Instance.dispose()
        }
      },
    })
  } finally {
    HostMcp.set({})
  }
}, 20_000)

test("host entry without sampling defaults to ask instead of inheriting user allow", () => {
  const hostWithoutSampling = {
    type: "local" as const,
    command: ["true"],
    enabled: true,
  }
  const userAllow = {
    type: "local" as const,
    command: ["true"],
    enabled: true,
    sampling: "allow" as const,
  }
  // Same-snapshot ownership: host-owned entry defaults to ask.
  expect(MCP.hostEffectiveSampling(hostWithoutSampling, true)).toBe("ask")
  // Explicit host policy is preserved.
  expect(MCP.hostEffectiveSampling({ ...hostWithoutSampling, sampling: "deny" }, true)).toBe("deny")
  // User-owned entry keeps its own field (or undefined → policyFor default).
  expect(MCP.hostEffectiveSampling(userAllow, false)).toBe("allow")
  expect(MCP.hostEffectiveSampling(hostWithoutSampling, false)).toBeUndefined()
  // Ownership must be decided with the config object, not re-read later.
  expect(MCP.hostEffectiveSampling(hostWithoutSampling, false)).not.toBe(MCP.hostEffectiveSampling(hostWithoutSampling, true))
})

test("removed override with a failed user fallback retries after cooldown without reload", async () => {
  await using tmp = await fixture()
  const script = `${tmp.path}/flaky-user.mjs`
  const failGate = `${tmp.path}/fail-gate`
  await Bun.write(
    script,
    `
    import readline from 'node:readline';
    import fs from 'node:fs';
    if (fs.existsSync(process.env.FAIL_GATE)) process.exit(1);
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('close', () => process.exit(0));
    lines.on('line', async line => {
      const req = JSON.parse(line);
      if (req.id == null) return;
      const result = req.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {tools:{}}, serverInfo: {name: 'flaky', version: '1'} }
        : req.method === 'tools/list'
        ? { tools: [{name: 'read', inputSchema: {type: 'object'}}] }
        : { content: [{type: 'text', text: 'recovered'}] };
      process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: req.id, result}) + '\\n');
    });
    `,
  )
  const userCfg = {
    type: "local" as const,
    command: [process.execPath, script],
    enabled: true,
    environment: { FAIL_GATE: failGate },
  }
  await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify({ mcp: { automation: userCfg } }))
  await Bun.write(failGate, "fail")
  const good = tmp.extra.config("good")
  HostMcp.set({ automation: good })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          await Effect.runPromise(
            MCP.Service.use((mcp) =>
              Effect.gen(function* () {
                expect((yield* mcp.status()).automation?.status).toBe("connected")
                HostMcp.set({})
                yield* mcp.tools()
                expect((yield* mcp.status()).automation?.status).toBe("failed")
                yield* Effect.promise(() => unlink(failGate))
                yield* Effect.promise(() => Bun.sleep(5_100))
                yield* mcp.tools()
                expect((yield* mcp.status()).automation?.status).toBe("connected")
                const client = (yield* mcp.clients()).automation!
                const called = yield* Effect.promise(() => client.callTool({ name: "read", arguments: {} }))
                expect(called.content).toEqual([{ type: "text", text: "recovered" }])
              }),
            ).pipe(Effect.provide(MCP.defaultLayer)),
          )
        } finally {
          await Instance.dispose()
        }
      },
    })
  } finally {
    HostMcp.set({})
  }
}, 20_000)

test("manual disconnect after a host failure is not auto-revived by discovery", async () => {
  await using tmp = await fixture()
  const broken = {
    type: "local" as const,
    command: [process.execPath, "-e", "process.exit(1)"],
    enabled: true,
    environment: { FIXTURE_LABEL: "broken", FIXTURE_LOG: `${tmp.extra.log}` },
  }
  HostMcp.set({ automation: broken })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          await Effect.runPromise(
            MCP.Service.use((mcp) =>
              Effect.gen(function* () {
                yield* mcp.tools()
                expect((yield* mcp.status()).automation?.status).toBe("failed")
                yield* mcp.disconnect("automation")
                expect((yield* mcp.status()).automation?.status).toBe("disabled")
                yield* Effect.promise(() => Bun.sleep(5_100))
                yield* mcp.tools()
                expect((yield* mcp.status()).automation?.status).toBe("disabled")
                expect((yield* mcp.clients()).automation).toBeUndefined()
              }),
            ).pipe(Effect.provide(MCP.defaultLayer)),
          )
        } finally {
          await Instance.dispose()
        }
      },
    })
  } finally {
    HostMcp.set({})
  }
}, 20_000)

test("interrupting create during tools/list closes the unpublished client", async () => {
  await using tmp = await fixture()
  const script = `${tmp.path}/hang-list.mjs`
  const listed = `${tmp.path}/tools-list.started`
  const pidFile = `${tmp.path}/hang.pid`
  await Bun.write(
    script,
    `
    import readline from 'node:readline';
    import fs from 'node:fs';
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('close', () => process.exit(0));
    lines.on('line', async line => {
      const req = JSON.parse(line);
      if (req.id == null) return;
      if (req.method === 'initialize') {
        fs.writeFileSync(process.env.PID_FILE, String(process.pid));
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'hang',version:'1'}}}) + '\\n');
        return;
      }
      if (req.method === 'tools/list') {
        fs.writeFileSync(process.env.LISTED_FILE, 'listed');
        await new Promise(() => {});
        return;
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{content:[]}}) + '\\n');
    });
    process.on('SIGTERM', () => process.exit(0));
    `,
  )
  HostMcp.set({
    automation: {
      type: "local",
      command: [process.execPath, script],
      enabled: true,
      timeout: 10_000,
      environment: { LISTED_FILE: listed, PID_FILE: pidFile },
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          await Effect.runPromise(
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(
                MCP.Service.use((mcp) => mcp.tools()).pipe(Effect.provide(MCP.defaultLayer)),
              )
              // Barrier is tools/list itself: initialize completed and defs() is waiting.
              yield* Effect.promise(() => waitForFile(listed))
              yield* Fiber.interrupt(fiber)
              yield* Effect.promise(async () => {
                const pid = Number(await Bun.file(pidFile).text())
                for (let i = 0; i < 200; i++) {
                  try {
                    process.kill(pid, 0)
                    await Bun.sleep(20)
                  } catch {
                    break
                  }
                }
                expect(() => process.kill(pid, 0)).toThrow()
              })
              yield* MCP.Service.use((mcp) =>
                Effect.gen(function* () {
                  expect((yield* mcp.status()).automation?.status).not.toBe("connected")
                }),
              ).pipe(Effect.provide(MCP.defaultLayer))
            }),
          )
        } finally {
          await Instance.dispose()
        }
      },
    })
  } finally {
    HostMcp.set({})
  }
}, 20_000)

test.skipIf(process.platform === "win32")(
  "retired local server reaps worker descendants before dropping the registry entry",
  async () => {
    await using tmp = await fixture()
    const script = `${tmp.path}/parent-worker.mjs`
    const workerPid = `${tmp.path}/worker.pid`
    let worker: number | undefined
    await Bun.write(
      script,
      `
    import readline from 'node:readline';
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore', detached:true});
    worker.unref();
    fs.writeFileSync(process.env.WORKER_PID, String(worker.pid));
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('close', () => process.exit(0));
    lines.on('line', async line => {
      const req = JSON.parse(line);
      if (req.id == null) return;
      const result = req.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {tools:{}}, serverInfo: {name: 'parent', version: '1'} }
        : req.method === 'tools/list'
        ? { tools: [{name: 'read', inputSchema: {type: 'object'}}] }
        : { content: [{type: 'text', text: process.env.FIXTURE_LABEL}] };
      process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: req.id, result}) + '\\n');
    });
    `,
    )
    const config = (label: string, enabled = true) => ({
      type: "local" as const,
      command: [process.execPath, script],
      enabled,
      environment: { FIXTURE_LABEL: label, WORKER_PID: workerPid },
    })
    HostMcp.set({ automation: config("first") })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          try {
            await Effect.runPromise(
              MCP.Service.use((mcp) =>
                Effect.gen(function* () {
                  yield* mcp.tools()
                  yield* Effect.promise(() => waitForFile(workerPid))
                  const pid = Number(yield* Effect.promise(() => Bun.file(workerPid).text()))
                  worker = pid
                  expect(() => process.kill(pid, 0)).not.toThrow()
                  HostMcp.set({ automation: config("second") })
                  yield* mcp.tools()
                  yield* Effect.promise(async () => {
                    for (let i = 0; i < 200; i++) {
                      try {
                        process.kill(pid, 0)
                        await Bun.sleep(20)
                      } catch {
                        break
                      }
                    }
                    expect(() => process.kill(pid, 0)).toThrow()
                  })
                  worker = undefined
                }),
              ).pipe(Effect.provide(MCP.defaultLayer)),
            )
          } finally {
            await Instance.dispose()
          }
        },
      })
    } finally {
      HostMcp.set({})
      if (worker !== undefined) {
        try {
          process.kill(worker, "SIGTERM")
        } catch {}
      }
    }
  },
  20_000,
)
