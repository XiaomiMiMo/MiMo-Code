import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { EventsClient } from "../../src/mcp/events-protocol"

const fixture = fileURLToPath(new URL("./fixtures/events-stdio-server.mjs", import.meta.url))
const options = (mode: string) => ({ command: Bun.which("node")!, args: [fixture, mode], requestTimeoutMs: 10_000 })
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("SEP-3415 stdio protocol", () => {
  test("discovers extension, lists events, correlates concurrent streams and cancels", async () => {
    const client = await EventsClient.connect(options("normal"))
    try {
      const descriptors = await client.listEvents()
      expect(descriptors.map((item) => item.name)).toEqual(["mail.created"])
      const first: string[] = []
      const second: string[] = []
      const heartbeats: (string | null)[] = []
      const a = client.openStream(
        { name: "mail.created", arguments: { tag: "a" } },
        {
          onEvent: (event) => {
            first.push(event.eventId)
          },
          onHeartbeat: (value) => {
            heartbeats.push(value)
          },
        },
      )
      const b = client.openStream(
        { name: "mail.created", arguments: { tag: "b" } },
        {
          onEvent: (event) => {
            second.push(event.eventId)
          },
        },
      )
      await Promise.all([a.ready, b.ready])
      await delay(100)
      expect(first).toEqual(["event-a"])
      expect(second).toEqual(["event-b"])
      expect(heartbeats).toEqual(["cursor-2"])
      await a.cancel()
      await b.cancel()
      await delay(25)
      expect(first).toEqual(["event-a"])
      expect(second).toEqual(["event-b"])
    } finally {
      await client.close()
    }
  })

  test.each(["legacy", "old"])("refuses unsupported negotiation: %s", async (mode) => {
    await expect(EventsClient.connect(options(mode))).rejects.toThrow()
  })

  test("rejects repeated pagination cursors", async () => {
    const client = await EventsClient.connect(options("repeated-cursor"))
    try {
      await expect(client.listEvents()).rejects.toThrow("Repeated")
    } finally {
      await client.close()
    }
  })

  test("exposes immediate JSON-RPC subscription errors", async () => {
    const client = await EventsClient.connect(options("normal"))
    try {
      const stream = client.openStream({ name: "denied" }, { onEvent: () => {} })
      await expect(stream.ready).rejects.toThrow("Forbidden")
    } finally {
      await client.close()
    }
  })

  test("refuses event before active confirmation", async () => {
    const client = await EventsClient.connect(options("pre-active"))
    try {
      const stream = client.openStream(
        { name: "mail.created" },
        {
          onEvent: () => {
            throw new Error("must not deliver")
          },
        },
      )
      await expect(stream.ready).rejects.toThrow("before events/active")
    } finally {
      await client.close()
    }
  })

  test("times out only waiting for stream activation", async () => {
    const client = await EventsClient.connect({ ...options("never-active"), requestTimeoutMs: 600 })
    try {
      const stream = client.openStream({ name: "mail.created" }, { onEvent: () => {} })
      await expect(stream.ready).rejects.toThrow("activation timed out")
    } finally {
      await client.close()
    }
  })

  test("ends silent streams on heartbeat timeout", async () => {
    const client = await EventsClient.connect({ ...options("silent"), heartbeatTimeoutMs: 80 })
    const errors: string[] = []
    try {
      const stream = client.openStream(
        { name: "mail.created" },
        {
          onEvent: () => {},
          onError: (error) => {
            errors.push(error.message)
          },
        },
      )
      await stream.ready
      await delay(150)
      expect(errors).toEqual(["MCP event stream heartbeat timed out"])
    } finally {
      await client.close()
    }
  })

  test("cancels streams if the consumer cannot keep up", async () => {
    const client = await EventsClient.connect({ ...options("flood"), maxPendingNotifications: 2 })
    const errors: string[] = []
    try {
      const stream = client.openStream(
        { name: "mail.created" },
        {
          onEvent: async () => {
            await delay(50)
          },
          onError: (error) => {
            errors.push(error.message)
          },
        },
      )
      await stream.ready
      await delay(200)
      expect(errors).toEqual(["Event callback backlog exceeded"])
    } finally {
      await client.close()
    }
  })

  test("delivers occurrence before normal stream close", async () => {
    const client = await EventsClient.connect(options("finish"))
    const calls: string[] = []
    try {
      const stream = client.openStream(
        { name: "mail.created" },
        {
          onEvent: async () => {
            await delay(30)
            calls.push("event")
          },
          onClose: (reason) => {
            calls.push(reason)
          },
        },
      )
      await stream.ready
      await delay(120)
      expect(calls).toEqual(["event", "ended"])
    } finally {
      await client.close()
    }
  })
})
