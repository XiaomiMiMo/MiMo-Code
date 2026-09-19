import { test, expect } from "bun:test"
import { Effect } from "effect"
import { MCP } from "../../src/mcp"
import { HostMcp } from "../../src/mcp/host"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("host readiness refreshes a cached instance while other MCP calls continue", async () => {
  await using tmp = await tmpdir()
  const script = `${tmp.path}/server.mjs`
  await Bun.write(script, `
    import readline from 'node:readline';
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const req = JSON.parse(line);
      if (req.id == null) return;
      const result = req.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1'} }
        : req.method === 'tools/list'
        ? { tools: [{name: 'read', inputSchema: {type: 'object'}}] }
        : { content: [{type: 'text', text: process.env.FIXTURE_LABEL}] };
      setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: req.id, result}) + '\\n'), req.method === 'tools/call' ? 150 : 0);
    });
  `)
  const config = (label: string, enabled = true) => ({
    type: "local" as const, command: [process.execPath, script], enabled, environment: { FIXTURE_LABEL: label },
  })
  await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify({ mcp: { other: config("other") } }))
  HostMcp.set({ automation: config("first", false) })
  try {
    await Instance.provide({ directory: tmp.path, fn: async () => {
      await Effect.runPromise(MCP.Service.use((mcp) => Effect.gen(function* () {
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
        expect((yield* Effect.promise(() => restored.callTool({ name: "read", arguments: {} }))).content)
          .toEqual([{ type: "text", text: "other" }])
      })).pipe(Effect.provide(MCP.defaultLayer)))
      await Instance.dispose()
    } })
  } finally { HostMcp.set({}) }
}, 20_000)
