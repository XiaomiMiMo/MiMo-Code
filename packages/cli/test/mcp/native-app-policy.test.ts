import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import z from "zod/v4"
import { CLIENT_OPTIONS } from "../../src/mcp/client-options"
import { McpElicitation } from "../../src/mcp/elicitation"
import { NATIVE_APP_POLICY_CAPABILITY, serve } from "../../src/mcp/native-app-policy"

test("native app policy is restricted to one active parent turn", async () => {
  const client = new Client({ name: "fixture", version: "1" }, CLIENT_OPTIONS)
  const server = new Server({ name: "fixture", version: "1" }, { capabilities: {} })
  serve(client)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(a), server.connect(b)])
  const read = (sessionId: string, turnId: string) => server.request({
    method: `${NATIVE_APP_POLICY_CAPABILITY}/read`,
    params: { _meta: { "com.xiaomi.mimo/turn-lifecycle": { sessionId, turnId } } },
  }, z.object({ policy: z.unknown() }))
  try {
    await expect(read("ses_fixture", "turn-a")).rejects.toThrow()
    const end = McpElicitation.beginCall(client, "ses_fixture", undefined, "turn-a")
    try {
      await expect(read("ses_fixture", "turn-b")).rejects.toThrow()
      const result = await read("ses_fixture", "turn-a")
      expect(result.policy).toMatchObject({ enabled: true, allowPersistentApproval: false })
      const endOverlap = McpElicitation.beginCall(client, "ses_fixture", undefined, "turn-b")
      try { await expect(read("ses_fixture", "turn-a")).rejects.toThrow() } finally { endOverlap() }
    } finally { end() }
    await expect(read("ses_fixture", "turn-a")).rejects.toThrow()
    const controller = new AbortController()
    const endCancelled = McpElicitation.beginCall(client, "ses_fixture", controller.signal, "turn-a")
    controller.abort()
    try { await expect(read("ses_fixture", "turn-a")).rejects.toThrow() } finally { endCancelled() }
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})
