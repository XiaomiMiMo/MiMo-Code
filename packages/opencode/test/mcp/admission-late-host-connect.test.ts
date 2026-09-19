import { expect } from "bun:test";
import { createRequire } from "node:module";
const root = import.meta.dir + "/../../";
const req = createRequire(`${root}package.json`);
const { Effect, Layer, Fiber } = await import(req.resolve("effect"));
const { MCP } = await import(`${root}src/mcp/index.ts`);
const { HostMcp } = await import(`${root}src/mcp/host.ts`);
const { provideTmpdirInstance } = await import(`${root}test/fixture/fixture.ts`);
const { testEffect } = await import(`${root}test/lib/effect.ts`);
const { McpAuth } = await import(`${root}src/mcp/auth.ts`);
const CrossSpawnSpawner = await import(`${root}src/effect/cross-spawn-spawner.ts`);
const it = testEffect(Layer.mergeAll(MCP.defaultLayer, McpAuth.defaultLayer, CrossSpawnSpawner.defaultLayer));
it.live("review R014: late host connect cannot replace newer host generation", () => Effect.gen(function* () {
  let release!: () => void;
  let entered!: () => void;
  let oldLists = 0;
  const blocked = new Promise<void>(r => release = r);
  const started = new Promise<void>(r => entered = r);
  yield* Effect.addFinalizer(() => Effect.sync(() => { release(); HostMcp.set({}); }));
  const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, {status: 405});
      const msg = await request.json();
      if (msg.id == null) return new Response(null, {status: 202});
      const name = new URL(request.url).pathname === "/old" ? "old" : "new";
      if (msg.method === "tools/list" && name === "old" && ++oldLists === 2) { entered(); await blocked; }
      const result = msg.method === "initialize"
        ? {protocolVersion: "2024-11-05", capabilities: {tools: {}}, serverInfo: {name, version: "1"}}
        : {tools: [{name, inputSchema: {type: "object"}}]};
      return Response.json({jsonrpc: "2.0", id: msg.id, result});
    }
  })), server => Effect.promise(() => server.stop(true)));
  const cfg = (endpoint: string) => ({type: "remote" as const, url: `${server.url}${endpoint}`, oauth: false as const, enabled: true});
  HostMcp.set({example: cfg("old")});
  yield* provideTmpdirInstance(() => Effect.gen(function* () {
    const mcp = yield* MCP.Service;
    expect(Object.keys(yield* mcp.tools())).toEqual(["example_old"]);
    const pending = yield* mcp.connect("example").pipe(Effect.forkChild);
    yield* Effect.promise(() => started);
    HostMcp.set({example: cfg("new")});
    expect(Object.keys(yield* mcp.tools())).toEqual(["example_new"]);
    release();
    yield* Fiber.join(pending);
    const tools = Object.keys(yield* mcp.tools());
    console.log("R014_LATE_HOST_GENERATION", JSON.stringify({tools}));
    expect(tools).toEqual(["example_new"]);
  }));
}));
