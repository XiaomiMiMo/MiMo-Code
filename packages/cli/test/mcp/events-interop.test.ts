import { describe, expect, test } from "bun:test"
import { EventsClient } from "../../src/mcp/events-protocol"

// Optional external interoperability test. Start the independent mcpkit
// kitchen-sink server on loopback and set MIMOCODE_EVENTS_INTEROP_URL.
const endpoint = process.env.MIMOCODE_EVENTS_INTEROP_URL

describe.skipIf(!endpoint)("independent MCP Events server", () => {
  test("discovers, subscribes and receives an event over HTTP", async () => {
    const client = await EventsClient.connect({ url: new URL(endpoint!), allowInsecureLoopback: true })
    try {
      const items = await client.listEvents()
      expect(items.find((item) => item.name === "chat.message")?.delivery).toContain("push")
      const got = Promise.withResolvers<string>()
      const stream = client.openStream({ name: "chat.message", arguments: { channel: "general" } }, {
        onEvent: (event) => got.resolve(event.name),
        onError: (error) => got.reject(error),
      })
      await stream.ready
      expect(await Promise.race([got.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("event timed out")), 10_000))])).toBe("chat.message")
      await stream.cancel()
    } finally {
      await client.close()
    }
  }, 20_000)
})
