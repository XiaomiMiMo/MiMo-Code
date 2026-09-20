import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { toolPresentationProgress } from "../../src/mcp/tool-progress"

test("MCP progress retains presentation metadata before result and drains ordered writes", async () => {
  const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } })
  let finished = false
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    for (const browserId of ["iab", "chrome"]) {
      await server.notification({
        method: "notifications/progress",
        params: {
          progressToken: request.params._meta!.progressToken!,
          progress: browserId === "iab" ? 1 : 2,
          _meta: { "mimo/toolSurface": { kind: "browserUse", browserId } },
        },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    return { content: [] }
  })
  const client = new Client({ name: "test", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  const seen: string[] = []
  const progress = toolPresentationProgress({
    onMcpToolProgress: async (meta: Record<string, { browserId: string }>) => {
      expect(finished).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 10))
      seen.push(meta["mimo/toolSurface"].browserId)
    },
  })
  try {
    await client.callTool({ name: "js", arguments: {} }, undefined, { onprogress: progress.update })
    await progress.drain()
    finished = true
    expect(seen).toEqual(["iab", "chrome"])
  } finally {
    await client.close()
    await server.close()
  }
})

test("progress ignores unrelated and oversized metadata without leaking across calls", async () => {
  const seen: unknown[] = []
  const first = toolPresentationProgress({
    onMcpToolProgress: async (meta: unknown) => {
      seen.push(meta)
    },
  })
  first.update({ message: "loading" })
  first.update({ _meta: { secret: "private" } })
  first.update({ _meta: { "mimo/toolSurface": { kind: "browserUse", browserId: "x".repeat(400_001) } } })
  toolPresentationProgress(undefined).update({
    _meta: { "mimo/toolSurface": { kind: "browserUse", browserId: "iab" } },
  })
  await first.drain()
  expect(seen).toEqual([])
})
