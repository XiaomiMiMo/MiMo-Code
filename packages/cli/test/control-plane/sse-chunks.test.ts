import { expect, test } from "bun:test"
import { parseSSE } from "../../src/control-plane/sse"

async function parse(parts: Uint8Array[]) {
  const events: unknown[] = []
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part))
      controller.close()
    },
  })
  await parseSSE(body, new AbortController().signal, (event) => events.push(event))
  expect(body.locked).toBe(false)
  return events
}

test("CRLF multiline SSE is independent of every byte split", async () => {
  const wire = new TextEncoder().encode('data: {"message":\r\ndata: "中文😀"}\r\n\r\n')
  for (let i = 0; i <= wire.length; i++) {
    expect(await parse([wire.slice(0, i), new Uint8Array(), wire.slice(i)])).toEqual([{ message: "中文😀" }])
  }
  expect(await parse(Array.from(wire, (byte) => Uint8Array.of(byte)))).toEqual([{ message: "中文😀" }])
})

test("lone CR remains an immediate event delimiter", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const events: unknown[] = []
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
  })
  const pending = parseSSE(body, new AbortController().signal, (event) => events.push(event))
  controller.enqueue(new TextEncoder().encode('data: {"ok":true}\r\r'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const observed = events.slice()
  controller.close()
  await pending
  expect(observed).toEqual([{ ok: true }])
})
