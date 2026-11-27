import { describe, expect, test } from "bun:test"
import { parseSSE } from "../../src/control-plane/sse"

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)))
      controller.close()
    },
  })
}

describe("control-plane/sse", () => {
  test("parses JSON events with CRLF and multiline data blocks", async () => {
    const events: unknown[] = []
    const stop = new AbortController()

    await parseSSE(
      stream([
        'data: {"type":"one","properties":{"ok":true}}\r\n\r\n',
        'data: {"type":"two",\r\ndata: "properties":{"n":2}}\r\n\r\n',
      ]),
      stop.signal,
      (event) => events.push(event),
    )

    expect(events).toEqual([
      { type: "one", properties: { ok: true } },
      { type: "two", properties: { n: 2 } },
    ])
  })

  test("propagates onEvent errors without emitting a phantom sse.message event", async () => {
    const events: unknown[] = []
    const stop = new AbortController()
    let calls = 0

    const result = parseSSE(stream(['data: {"type":"one"}\n\n']), stop.signal, (event) => {
      events.push(event)
      calls += 1
      if (calls === 1) throw new Error("consumer failed")
    })

    // The consumer's throw must not be misclassified as a JSON.parse
    // failure: it must propagate, and no fallback event may be emitted.
    await expect(result).rejects.toThrow("consumer failed")
    expect(events).toEqual([{ type: "one" }])
  })

  test("falls back to sse.message for non-json payload", async () => {
    const events: unknown[] = []
    const stop = new AbortController()

    await parseSSE(stream(["id: abc\nretry: 1500\ndata: hello world\n\n"]), stop.signal, (event) => events.push(event))

    expect(events).toEqual([
      {
        type: "sse.message",
        properties: {
          data: "hello world",
          id: "abc",
          retry: 1500,
        },
      },
    ])
  })
})
