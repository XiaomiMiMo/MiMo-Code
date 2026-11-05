import { describe, expect, test } from "bun:test"
import { EventsClient } from "../../src/mcp/events-protocol"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { Effect, Layer, ManagedRuntime } from "effect"
import { McpAuth } from "../../src/mcp/auth"

const meta = (id: number) => ({ "io.modelcontextprotocol/subscriptionId": id })
const event = (id: number, method: string, params: Record<string, unknown>) => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method, params: { ...params, _meta: meta(id) } })}\n\n`
const send = (id: number, result: unknown) => Response.json({ jsonrpc: "2.0", id, result })

describe("remote MCP Events", () => {
  test("uses authenticated Streamable HTTP and delivers a pushed event", async () => {
    const seen: Array<{ method: string | null; name: string | null; auth: string | null }> = []
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const body = await request.json() as { id: number; method: string; params: { name?: string } }
      seen.push({ method: request.headers.get("mcp-method"), name: request.headers.get("mcp-name"), auth: request.headers.get("authorization") })
      if (request.headers.get("authorization") !== "Bearer example") return new Response(null, { status: 401 })
      if (body.method === "server/discover") return send(body.id, { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { extensions: { "io.modelcontextprotocol/events": {} } } })
      if (body.method === "events/list") return send(body.id, { resultType: "complete", events: [{ name: "mail.created", delivery: ["push"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } }] })
      if (body.method === "events/stream") {
        const stream = new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(event(body.id, "notifications/events/active", { cursor: null })))
          controller.enqueue(new TextEncoder().encode(event(body.id, "notifications/events/event", { eventId: "e1", name: "mail.created", timestamp: "2026-10-30T12:00:00Z", data: {}, cursor: null })))
        } })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      return new Response(null, { status: 404 })
    } })
    let client: EventsClient | undefined
    try {
      client = await EventsClient.connect({ url: new URL(`${server.url}mcp`), headers: { authorization: "Bearer example" }, allowInsecureLoopback: true })
      expect((await client.listEvents()).map((e) => e.name)).toEqual(["mail.created"])
      const received = Promise.withResolvers<string>()
      const subscription = client.openStream({ name: "mail.created" }, { onEvent: (item) => received.resolve(item.eventId) })
      await subscription.ready
      expect(await received.promise).toBe("e1")
      await subscription.cancel()
      expect(seen).toEqual([
        { method: "server/discover", name: null, auth: "Bearer example" },
        { method: "events/list", name: null, auth: "Bearer example" },
        { method: "events/stream", name: "mail.created", auth: "Bearer example" },
      ])
    } finally {
      await client?.close()
      await server.stop(true)
    }
  })

  test("uses URL-bound stored OAuth tokens without forwarding them to other servers", async () => {
    const auth = ManagedRuntime.make(Layer.mergeAll(McpAuth.defaultLayer))
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer example-oauth") return new Response(null, { status: 401 })
      const body = await request.json() as { id: number; method: string }
      if (body.method === "server/discover") return send(body.id, { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { extensions: { "io.modelcontextprotocol/events": {} } } })
      return send(body.id, { resultType: "complete", events: [] })
    } })
    const url = `${server.url}mcp`
    const name = `example-events-${crypto.randomUUID()}`
    let client: EventsClient | undefined
    try {
      const service = await auth.runPromise(McpAuth.Service.use((service) => Effect.succeed(service)))
      await auth.runPromise(service.updateTokens(name, { accessToken: "example-oauth" }, url))
      const provider = new McpOAuthProvider(name, url, {}, { onRedirect: () => { throw new Error("unexpected OAuth redirect") } }, service)
      client = await EventsClient.connect({ url: new URL(url), authProvider: { token: async () => (await provider.tokens())?.access_token }, allowInsecureLoopback: true })
      expect(await client.listEvents()).toEqual([])
      const other = new McpOAuthProvider(name, `${server.url}other`, {}, { onRedirect: () => {} }, service)
      expect(await other.tokens()).toBeUndefined()
    } finally {
      await client?.close()
      await auth.runPromise(McpAuth.Service.use((service) => service.remove(name)))
      await auth.dispose()
      await server.stop(true)
    }
  })

  test("rejects oversized HTTP event frames", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as { id: number; method: string }
      if (body.method === "server/discover") return send(body.id, { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { extensions: { "io.modelcontextprotocol/events": {} } } })
      if (body.method === "events/list") return send(body.id, { resultType: "complete", events: [{ name: "mail.created", delivery: ["push"], inputSchema: {}, payloadSchema: {} }] })
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(event(body.id, "notifications/events/active", { cursor: null })))
        controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(1_100_000)}`))
      } }), { headers: { "content-type": "text/event-stream" } })
    } })
    let client: EventsClient | undefined
    try {
      client = await EventsClient.connect({ url: new URL(`${server.url}mcp`), allowInsecureLoopback: true })
      const failure = Promise.withResolvers<string>()
      const stream = client.openStream({ name: "mail.created" }, { onEvent: () => {}, onError: (error) => failure.resolve(error.message) })
      await stream.ready
      expect(await Promise.race([failure.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("no failure")), 2000))])).toContain("size limit")
    } finally {
      await client?.close()
      await server.stop(true)
    }
  })

  test("does not forward refresh tokens to an unverified OAuth issuer", async () => {
    let metadataRequests = 0
    let metadataURL = ""
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname !== "/mcp") metadataRequests++
      return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${metadataURL}"` } })
    } })
    metadataURL = `${server.url}metadata`
    try {
      await expect(EventsClient.connect({ url: new URL(`${server.url}mcp`), authProvider: { token: async () => "expired-token" }, allowInsecureLoopback: true })).rejects.toThrow()
      expect(metadataRequests).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

  test("rejects insecure remote URLs and credentials in the URL", async () => {
    await expect(EventsClient.connect({ url: new URL("http://example.invalid/mcp") })).rejects.toThrow("requires HTTPS")
    await expect(EventsClient.connect({ url: new URL("https://user:pass@example.invalid/mcp") })).rejects.toThrow("cannot contain credentials")
  })
})
