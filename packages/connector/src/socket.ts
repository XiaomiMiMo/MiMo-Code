// A JSON-frame WebSocket with the handshake Connect requires: bearer + device
// proof headers and exactly one subprotocol. Runs on Bun, whose WebSocket accepts
// handshake headers; other runtimes inject their own `Dial`.

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
  /** Inbound frames larger than this close the socket with 1009. */
  maxFrameBytes: number
  handlers: SocketHandlers
}

export type Dial = (input: DialInput) => Promise<FrameSocket>

/** Closes when the peer sends a frame this side cannot accept. */
export const CLOSE_POLICY = 1008
export const CLOSE_TOO_LARGE = 1009

export const bunDial: Dial = (input) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(input.url, {
      headers: Object.fromEntries(input.headers.entries()),
      protocols: [input.protocol],
    } as unknown as string[])
    let opened = false
    const socket: FrameSocket = {
      get protocol() {
        return ws.protocol
      },
      send: (frame) => ws.send(JSON.stringify(frame)),
      close: (code, reason) => ws.close(code, reason),
    }
    ws.addEventListener("open", () => {
      opened = true
      // The service must select exactly the protocol we offered.
      if (ws.protocol !== input.protocol) {
        ws.close(CLOSE_POLICY, "protocol")
        reject(new Error("unexpected subprotocol"))
        return
      }
      resolve(socket)
    })
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return ws.close(CLOSE_POLICY, "binary")
      if (new TextEncoder().encode(event.data).length > input.maxFrameBytes) {
        return ws.close(CLOSE_TOO_LARGE, "too_large")
      }
      let frame: unknown
      try {
        frame = JSON.parse(event.data)
      } catch {
        return ws.close(CLOSE_POLICY, "invalid_json")
      }
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
        return ws.close(CLOSE_POLICY, "invalid_frame")
      }
      input.handlers.onFrame(frame as Record<string, unknown>)
    })
    ws.addEventListener("close", (event) => {
      if (!opened) reject(new Error(`handshake failed (${event.code})`))
      else input.handlers.onClose(event.code, event.reason)
    })
    ws.addEventListener("error", () => {
      if (!opened) reject(new Error("handshake failed"))
    })
  })

export function wssUrl(origin: string, path: string): string {
  const url = new URL(path, origin)
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:"
  return url.toString()
}
