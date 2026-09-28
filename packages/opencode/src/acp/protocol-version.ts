import { PROTOCOL_VERSION, type ndJsonStream } from "@agentclientprotocol/sdk"

type ACPStream = ReturnType<typeof ndJsonStream>
type ACPMessage = ACPStream["readable"] extends ReadableStream<infer Message> ? Message : never

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function normalizeInitializeProtocolVersion<T>(message: T): T {
  if (!isRecord(message)) return message
  if (message.method !== "initialize") return message

  const params = message.params
  if (!isRecord(params)) return message
  if (typeof params.protocolVersion !== "string") return message

  return {
    ...message,
    params: {
      ...params,
      protocolVersion: PROTOCOL_VERSION,
    },
  } as T
}

export function normalizeAcpProtocolVersionStream(stream: ACPStream): ACPStream {
  return {
    readable: stream.readable.pipeThrough(
      new TransformStream<ACPMessage, ACPMessage>({
        transform(message, controller) {
          controller.enqueue(normalizeInitializeProtocolVersion(message))
        },
      }),
    ),
    writable: stream.writable,
  }
}
