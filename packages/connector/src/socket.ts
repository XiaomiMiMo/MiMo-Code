// A JSON-frame WebSocket with the handshake Connect requires: bearer + device
// proof headers, exactly one subprotocol and the negotiated mechanisms echoed in
// the 101 response. Neither Bun's WebSocket nor its node:http client exposes the
// 101 response, so the handshake and RFC 6455 framing run here over a plain
// TLS (or loopback TCP) socket.

import { createHash, randomBytes } from "node:crypto"
import net from "node:net"
import tls from "node:tls"

export interface FrameSocket {
  readonly protocol: string
  send(frame: Record<string, unknown>): void
  close(code?: number, reason?: string): void
}

export type SocketHandlers = {
  onFrame(frame: Record<string, unknown>): void
  onClose(code: number, reason: string): void
}

export type DialInput = {
  url: string
  headers: Headers
  protocol: string
  /**
   * Request headers the 101 response must echo exactly once with the same value
   * (the request id and every negotiated mechanism). A missing, repeated or
   * different echo fails the handshake: nothing is ever enabled by assumption.
   */
  echo: string[]
  /** Inbound frames larger than this close the socket with 1009. */
  maxFrameBytes: number
  handlers: SocketHandlers
}

export type Dial = (input: DialInput) => Promise<FrameSocket>

/** The service refused the upgrade with an HTTP answer; Retry-After feeds the shared cooldown. */
export class HandshakeRejected extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`handshake rejected (${status})`)
    this.name = "HandshakeRejected"
  }
}

/** Closes when the peer sends a frame this side cannot accept. */
export const CLOSE_POLICY = 1008
export const CLOSE_TOO_LARGE = 1009

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const MAX_HANDSHAKE_BYTES = 16384
const HANDSHAKE_TIMEOUT_MS = 10_000
/** After sending a close frame, wait this long for the peer's before dropping the socket. */
const CLOSE_LINGER_MS = 2_000

export const wsDial: Dial = (input) =>
  new Promise((resolve, reject) => {
    const url = new URL(input.url)
    const secure = url.protocol === "wss:"
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost"
    if (!secure && !(url.protocol === "ws:" && loopback)) return reject(new Error("insecure origin"))
    const port = Number(url.port) || (secure ? 443 : 80)
    const raw = secure
      ? tls.connect({ host: url.hostname, port, servername: url.hostname, ALPNProtocols: ["http/1.1"] })
      : net.connect({ host: url.hostname, port })
    const key = randomBytes(16).toString("base64")
    let settled = false
    const timeout = setTimeout(() => fail(new Error("handshake timeout")), HANDSHAKE_TIMEOUT_MS)
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      raw.destroy()
      reject(error)
    }
    raw.once(secure ? "secureConnect" : "connect", () => {
      const lines = [
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Protocol: ${input.protocol}`,
      ]
      for (const [name, value] of input.headers.entries()) lines.push(`${name}: ${value}`)
      raw.write(`${lines.join("\r\n")}\r\n\r\n`)
    })
    raw.on("error", (error: Error) => fail(error))
    raw.on("close", () => fail(new Error("handshake failed")))
    let buffered = Buffer.alloc(0)
    const onHandshake = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf("\r\n\r\n")
      if (end < 0) {
        if (buffered.length > MAX_HANDSHAKE_BYTES) fail(new Error("handshake too large"))
        return
      }
      raw.off("data", onHandshake)
      const response = parseResponse(buffered.subarray(0, end).toString("latin1"))
      const rest = buffered.subarray(end + 4)
      if (!response) return fail(new Error("invalid handshake response"))
      if (response.status !== 101) {
        return fail(new HandshakeRejected(response.status, single(response.headers, "retry-after") ?? null))
      }
      const accept = createHash("sha1").update(key + GUID).digest("base64")
      const valid =
        single(response.headers, "upgrade")?.toLowerCase() === "websocket" &&
        (single(response.headers, "connection") ?? "").toLowerCase().split(/\s*,\s*/).includes("upgrade") &&
        single(response.headers, "sec-websocket-accept") === accept &&
        single(response.headers, "sec-websocket-protocol") === input.protocol &&
        !response.headers.has("sec-websocket-extensions") &&
        input.echo.every((name) => {
          const sent = input.headers.get(name)
          return sent !== null && single(response.headers, name.toLowerCase()) === sent
        })
      if (!valid) return fail(new Error("handshake not accepted"))
      settled = true
      clearTimeout(timeout)
      raw.removeAllListeners("close")
      raw.removeAllListeners("error")
      resolve(new Connection(raw, input.protocol, input.maxFrameBytes, input.handlers, rest))
    }
    raw.on("data", onHandshake)
  })

type Response = { status: number; headers: Map<string, string[]> }

function parseResponse(text: string): Response | undefined {
  const [statusLine, ...lines] = text.split("\r\n")
  const status = /^HTTP\/1\.1 (\d{3})(?: .*)?$/.exec(statusLine ?? "")
  if (!status) return undefined
  const headers = new Map<string, string[]>()
  for (const line of lines) {
    const colon = line.indexOf(":")
    if (colon <= 0) return undefined
    const name = line.slice(0, colon).trim().toLowerCase()
    headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()])
  }
  return { status: Number(status[1]), headers }
}

/** The header's value when it appears exactly once, otherwise undefined. */
function single(headers: Map<string, string[]>, name: string): string | undefined {
  const values = headers.get(name)
  return values?.length === 1 ? values[0] : undefined
}

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** One open client connection: masked outbound frames, strict unmasked inbound frames. */
class Connection implements FrameSocket {
  private buffer: Buffer
  private message: Buffer[] = []
  private messageBytes = 0
  private closing = false
  private ended = false

  constructor(
    private readonly raw: net.Socket,
    readonly protocol: string,
    private readonly maxFrameBytes: number,
    private readonly handlers: SocketHandlers,
    initial: Buffer,
  ) {
    this.buffer = initial
    raw.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
      this.drain()
    })
    raw.on("error", () => this.finish(1006, ""))
    raw.on("close", () => this.finish(1006, ""))
    // Frames that arrived together with the 101 are delivered once the caller holds the socket
    // (after the dial promise's continuations, which run as microtasks).
    if (initial.length) setImmediate(() => this.drain())
  }

  send(frame: Record<string, unknown>): void {
    if (this.closing || this.ended) return
    this.write(OP_TEXT, Buffer.from(JSON.stringify(frame)))
  }

  close(code = 1000, reason = ""): void {
    if (this.closing || this.ended) return
    this.closing = true
    const text = Buffer.from(reason).subarray(0, 123)
    const payload = Buffer.alloc(2 + text.length)
    payload.writeUInt16BE(code, 0)
    text.copy(payload, 2)
    this.write(OP_CLOSE, payload)
    setTimeout(() => this.raw.destroy(), CLOSE_LINGER_MS).unref?.()
    this.finish(code, reason)
  }

  private drain(): void {
    while (!this.ended) {
      const frame = readFrame(this.buffer)
      if (frame === "incomplete") return
      if (frame === "invalid") {
        this.protocolError(CLOSE_POLICY, "invalid_frame")
        return
      }
      this.buffer = this.buffer.subarray(frame.length)
      if (!this.handle(frame)) return
    }
  }

  /** Handles one frame; false when the connection ended. */
  private handle(frame: Frame): boolean {
    if (frame.opcode >= 0x8) {
      if (!frame.fin || frame.payload.length > 125) return this.protocolError(CLOSE_POLICY, "invalid_frame")
      if (frame.opcode === OP_PING) this.write(OP_PONG, frame.payload)
      else if (frame.opcode === OP_CLOSE) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005
        const reason = frame.payload.subarray(2).toString("utf8")
        if (!this.closing) this.write(OP_CLOSE, frame.payload.subarray(0, 2))
        this.closing = true
        this.raw.end()
        this.finish(code, reason)
        return false
      } else if (frame.opcode !== OP_PONG) return this.protocolError(CLOSE_POLICY, "invalid_frame")
      return true
    }
    const starts = frame.opcode === OP_TEXT
    if (starts === this.message.length > 0 || (!starts && frame.opcode !== OP_CONTINUATION)) {
      // Binary messages and broken fragmentation are both outside the JSON-frame contract.
      return this.protocolError(CLOSE_POLICY, frame.opcode === 0x2 ? "binary" : "invalid_frame")
    }
    this.messageBytes += frame.payload.length
    if (this.messageBytes > this.maxFrameBytes) return this.protocolError(CLOSE_TOO_LARGE, "too_large")
    this.message.push(frame.payload)
    if (!frame.fin) return true
    const data = Buffer.concat(this.message)
    this.message = []
    this.messageBytes = 0
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))
    } catch {
      return this.protocolError(CLOSE_POLICY, "invalid_json")
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return this.protocolError(CLOSE_POLICY, "invalid_frame")
    }
    if (this.closing) return true
    this.handlers.onFrame(parsed as Record<string, unknown>)
    return !this.ended
  }

  private protocolError(code: number, reason: string): false {
    this.close(code, reason)
    return false
  }

  private write(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4)
    const length = payload.length
    const header =
      length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    header[0] = 0x80 | opcode
    if (length < 126) header[1] = 0x80 | length
    else if (length < 65536) {
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    const masked = Buffer.alloc(length)
    for (let i = 0; i < length; i++) masked[i] = payload[i]! ^ mask[i & 3]!
    this.raw.write(Buffer.concat([header, mask, masked]))
  }

  private finish(code: number, reason: string): void {
    if (this.ended) return
    this.ended = true
    this.handlers.onClose(code, reason)
  }
}

type Frame = { fin: boolean; opcode: number; payload: Buffer; length: number }

/** One complete inbound frame at the start of `buffer`; server frames are never masked. */
function readFrame(buffer: Buffer): Frame | "incomplete" | "invalid" {
  if (buffer.length < 2) return "incomplete"
  const first = buffer[0]!
  const second = buffer[1]!
  if (first & 0x70 || second & 0x80) return "invalid"
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return "incomplete"
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return "incomplete"
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return "invalid"
    length = Number(big)
    offset = 10
  }
  if (buffer.length < offset + length) return "incomplete"
  return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload: buffer.subarray(offset, offset + length), length: offset + length }
}

export function wssUrl(origin: string, path: string): string {
  const url = new URL(path, origin)
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:"
  return url.toString()
}
