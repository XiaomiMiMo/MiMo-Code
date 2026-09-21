import { describe, expect, test } from "bun:test"
import { PROTOCOL_VERSION, type ndJsonStream } from "@agentclientprotocol/sdk"
import { normalizeAcpProtocolVersionStream, normalizeInitializeProtocolVersion } from "../../src/acp/protocol-version"

type ACPStream = ReturnType<typeof ndJsonStream>
type ACPMessage = ACPStream["readable"] extends ReadableStream<infer Message> ? Message : never

function createStreamPair() {
  const clientToAgent = new TransformStream<ACPMessage, ACPMessage>()
  const agentToClient = new TransformStream<ACPMessage, ACPMessage>()

  return [
    {
      readable: agentToClient.readable,
      writable: clientToAgent.writable,
    },
    {
      readable: clientToAgent.readable,
      writable: agentToClient.writable,
    },
  ] as const
}

describe("acp protocol version compatibility", () => {
  test("normalizes string initialize protocolVersion to the SDK protocol version", () => {
    const message = normalizeInitializeProtocolVersion({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientCapabilities: {},
        clientInfo: { name: "opencLaw", version: "2026.6.9" },
      },
    })

    expect(message).toMatchObject({
      params: {
        protocolVersion: PROTOCOL_VERSION,
      },
    })
  })

  test("keeps numeric initialize protocolVersion unchanged", () => {
    const message = normalizeInitializeProtocolVersion({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
      },
    })

    expect(message).toMatchObject({
      params: {
        protocolVersion: 1,
      },
    })
  })

  test("normalizes initialize messages flowing into the ACP stream", async () => {
    const [clientStream, agentStream] = createStreamPair()
    const normalized = normalizeAcpProtocolVersionStream(agentStream)
    const writer = clientStream.writable.getWriter()
    const reader = normalized.readable.getReader()

    await writer.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
      },
    } as ACPMessage)

    const message = await reader.read()
    expect(message.value).toMatchObject({
      params: {
        protocolVersion: PROTOCOL_VERSION,
      },
    })

    await writer.close()
    reader.releaseLock()
  })
})
