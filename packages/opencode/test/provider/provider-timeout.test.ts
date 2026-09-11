import { describe, expect, test } from "bun:test"
import { normalizeTimeoutError, requestSignal, trackAbortSource, wrapRequestTimeout } from "../../src/provider/provider"

describe("provider timeout errors", () => {
  test("turns an internal timeout abort into a retryable connection error", () => {
    const request = new AbortController()
    const timeout = new AbortController()
    timeout.abort(new DOMException("The operation timed out", "TimeoutError"))

    const result = normalizeTimeoutError(
      new DOMException("The operation was aborted", "AbortError"),
      "timeout",
      timeout.signal,
    )

    expect(result).toBeInstanceOf(Error)
    expect((result as Error & { code?: string }).code).toBe("ETIMEDOUT")
  })

  test("preserves an abort when the caller cancelled the request", () => {
    const request = new AbortController()
    const timeout = new AbortController()
    const error = new DOMException("The user aborted the request", "AbortError")
    request.abort(error)
    timeout.abort(new DOMException("The operation timed out", "TimeoutError"))

    expect(normalizeTimeoutError(error, "request", timeout.signal)).toBe(error)
  })

  test("records the first abort source instead of inspecting final signal state", () => {
    const request = new AbortController()
    const timeout = new AbortController()
    const timeoutFirst = trackAbortSource(request.signal, [timeout.signal])
    timeout.abort()
    request.abort()
    expect(timeoutFirst.source()).toBe("timeout")
    expect(timeoutFirst.winner()).toBe(timeout.signal)
    timeoutFirst.dispose()

    const request2 = new AbortController()
    const timeout2 = new AbortController()
    const requestFirst = trackAbortSource(request2.signal, [timeout2.signal])
    request2.abort()
    timeout2.abort()
    expect(requestFirst.source()).toBe("request")
    expect(requestFirst.winner()).toBe(request2.signal)
    requestFirst.dispose()
  })

  test("inherits Request.signal unless init supplies one", () => {
    const request = new AbortController()
    const override = new AbortController()
    const input = new Request("https://example.com", { signal: request.signal })

    expect(requestSignal(input)).toBe(request.signal)
    expect(requestSignal(input, { signal: override.signal })).toBe(override.signal)
  })

  test("keeps the request timeout active while the response body is streaming", async () => {
    const timeout = new AbortController()
    let clearCount = 0
    let cancelled = false
    const response = wrapRequestTimeout(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"))
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
      undefined,
      timeout.signal,
      () => clearCount++,
    )
    const reader = response.body?.getReader()
    if (!reader) throw new Error("expected response body")

    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first")
    expect(clearCount).toBe(0)
    timeout.abort(new DOMException("The operation timed out", "TimeoutError"))

    const error = await reader.read().catch((error) => error)
    expect((error as Error & { code?: string }).code).toBe("ETIMEDOUT")
    expect(clearCount).toBe(1)
    await Bun.sleep(0)
    expect(cancelled).toBe(true)
  })

  test("keeps caller cancellation terminal while the response body is streaming", async () => {
    const request = new AbortController()
    const timeout = new AbortController()
    let cancelled = false
    const response = wrapRequestTimeout(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        }),
      ),
      request.signal,
      timeout.signal,
      () => {},
    )
    const reader = response.body?.getReader()
    if (!reader) throw new Error("expected response body")
    const pending = reader.read().catch((error) => error)

    request.abort(new DOMException("The user aborted the request", "AbortError"))

    const error = await pending
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe("AbortError")
    expect((error as Error & { code?: string | number }).code).not.toBe("ETIMEDOUT")
    await Bun.sleep(0)
    expect(cancelled).toBe(true)
  })
})
