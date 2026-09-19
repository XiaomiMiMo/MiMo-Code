// [TP-MCU-R7-21] Desktop computer-use: retired host connections follow request/turn lifetimes.
import { test, expect } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Effect } from "effect"
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
