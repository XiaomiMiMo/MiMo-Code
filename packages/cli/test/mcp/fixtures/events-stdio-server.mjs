import readline from "node:readline"

const mode = process.argv[2] ?? "normal"
const expected = "io.modelcontextprotocol/events"
const streams = new Map()
let discoverSeen = false

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
function validate(msg) {
  const meta = msg.params?._meta
  if (
    meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" ||
    !meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.[expected]
  ) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "missing protocol envelope" } })
    return false
  }
  return true
}
function notify(id, method, params = {}) {
  send({ jsonrpc: "2.0", method, params: { ...params, _meta: { "io.modelcontextprotocol/subscriptionId": id } } })
}

const input = readline.createInterface({ input: process.stdin })
input.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "notifications/cancelled") {
    const id = msg.params.requestId
    if (streams.has(id)) {
      streams.delete(id)
      // Purposely send a late notification; the cancelled stream must ignore it.
      notify(id, "notifications/events/event", {
        eventId: "late",
        name: "mail.created",
        timestamp: "2026-10-30T12:00:00Z",
        data: {},
      })
    }
    return
  }
  if (!validate(msg)) return
  if (msg.method === "server/discover") {
    discoverSeen = true
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        resultType: "complete",
        supportedVersions: mode === "old" ? ["2025-11-25"] : ["2026-07-28"],
        capabilities: mode === "legacy" ? { events: {} } : { extensions: { [expected]: {} } },
      },
    })
  }
  if (!discoverSeen) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "not discovered" } })
  if (msg.method === "events/list") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        resultType: "complete",
        events: [
          {
            name: "mail.created",
            delivery: ["push"],
            inputSchema: { type: "object" },
            payloadSchema: { type: "object" },
          },
        ],
        ...(mode === "repeated-cursor" ? { nextCursor: "repeat" } : {}),
      },
    })
  }
  if (msg.method === "events/stream") {
    const id = msg.id
    if (msg.params.name === "denied") return send({ jsonrpc: "2.0", id, error: { code: -32024, message: "Forbidden" } })
    streams.set(id, msg.params.arguments)
    if (mode === "never-active") return
    if (mode === "pre-active")
      return notify(id, "notifications/events/event", {
        eventId: "bad",
        name: msg.params.name,
        timestamp: "2026-10-30T12:00:00Z",
        data: {},
      })
    notify(id, "notifications/events/active", { cursor: "cursor-0", truncated: false })
    if (mode === "silent") return
    if (mode === "flood") {
      for (let i = 0; i < 20; i++)
        notify(id, "notifications/events/event", {
          eventId: `event-${i}`,
          name: msg.params.name,
          timestamp: "2026-10-30T12:00:00Z",
          data: { index: i },
          cursor: `cursor-${i}`,
        })
      return
    }
    const tag = msg.params.arguments?.tag ?? "none"
    setTimeout(() => {
      if (!streams.has(id)) return
      // Unknown subscription ID must be ignored, not forwarded to a live stream.
      notify(999999, "notifications/events/event", {
        eventId: "wrong",
        name: msg.params.name,
        timestamp: "2026-10-30T12:00:00Z",
        data: {},
      })
      notify(id, "notifications/events/event", {
        eventId: `event-${tag}`,
        name: msg.params.name,
        timestamp: "2026-10-30T12:00:00Z",
        data: { tag },
        cursor: "cursor-1",
      })
      notify(id, "notifications/events/heartbeat", { cursor: "cursor-2" })
      if (mode === "finish") {
        streams.delete(id)
        send({
          jsonrpc: "2.0",
          id,
          result: { resultType: "complete", _meta: { "io.modelcontextprotocol/subscriptionId": id } },
        })
      }
      if (mode === "terminate") {
        notify(id, "notifications/events/terminated", { error: { code: -32024, message: "Forbidden" } })
        streams.delete(id)
      }
    }, 15)
  }
})
input.on("close", () => process.exit(0))
