import { describe, expect, test } from "bun:test"
import type { NamedError } from "@mimo-ai/shared/util/error"
import { APICallError, RetryError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Schedule } from "effect"
import { SessionRetry, isRetryableTransientError, retryable } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID } from "../../src/provider/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const providerID = ProviderID.make("test")

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return new MessageV2.APIError({
    message: "boom",
    isRetryable: true,
    responseHeaders: headers,
  }).toObject() as MessageV2.APIError
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { data: { message } } as ReturnType<NamedError["toObject"]>
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  test("policy updates retry status and increments attempts", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("session-retry-test")
        const error = apiError({ "retry-after-ms": "0" })

        await Effect.runPromise(
          Effect.gen(function* () {
            const step = yield* Schedule.toStepWithMetadata(
              SessionRetry.policy({
                parse: (err) => err as MessageV2.APIError,
                set: (info) =>
                  Effect.promise(() =>
                    AppRuntime.runPromise(
                      SessionStatus.Service.use((svc) =>
                        svc.set(sessionID, {
                          type: "retry",
                          attempt: info.attempt,
                          message: info.message,
                          next: info.next,
                        }),
                      ),
                    ),
                  ),
              }),
            )
            yield* step(error)
            yield* step(error)
          }),
        )

        expect(await AppRuntime.runPromise(SessionStatus.Service.use((svc) => svc.get(sessionID)))).toMatchObject({
          type: "retry",
          attempt: 2,
          message: "boom",
        })
      },
    })
  })
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error)).toBe("Provider is overloaded")
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("does not retry context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject() as ReturnType<NamedError["toObject"]>

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = new MessageV2.APIError({
      message: "Internal server error",
      isRetryable: false,
      statusCode: 500,
      responseBody: '{"type":"api_error","message":"Internal server error"}',
    }).toObject() as MessageV2.APIError

    expect(SessionRetry.retryable(error)).toBe("Internal server error")
  })

  test("retries 502 bad gateway errors", () => {
    const error = new MessageV2.APIError({
      message: "Bad gateway",
      isRetryable: false,
      statusCode: 502,
    }).toObject() as MessageV2.APIError

    expect(SessionRetry.retryable(error)).toBe("Bad gateway")
  })

  test("retries 503 service unavailable errors", () => {
    const error = new MessageV2.APIError({
      message: "Service unavailable",
      isRetryable: false,
      statusCode: 503,
    }).toObject() as MessageV2.APIError

    expect(SessionRetry.retryable(error)).toBe("Service unavailable")
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = new MessageV2.APIError({
      message: "Bad request",
      isRetryable: false,
      statusCode: 400,
    }).toObject() as MessageV2.APIError

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = new MessageV2.APIError({
      message: "Response decompression failed",
      isRetryable: true,
      metadata: { code: "ZlibError" },
    }).toObject() as MessageV2.APIError

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Response decompression failed")
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
      expect((result as MessageV2.APIError).data.message).toBe("Connection reset by server")
      expect((result as MessageV2.APIError).data.metadata?.code).toBe("ECONNRESET")
      expect((result as MessageV2.APIError).data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = new MessageV2.APIError({
      message: "Connection reset by server",
      isRetryable: true,
      metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
    }).toObject() as MessageV2.APIError

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Connection reset by server")
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai") }) as MessageV2.APIError
    expect(result.data.isRetryable).toBe(true)
  })
})

describe("session.message-v2.fromError unwraps AI_RetryError", () => {
  const apiCall = (statusCode: number) =>
    new APICallError({
      message: "No available channel for model claude-sonnet-4.6 under group default",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":{"code":"model_not_found","type":"new_api_error"}}',
      isRetryable: true,
    })

  const retryWrapping = (statusCode: number) =>
    new RetryError({
      message: `Failed after 3 attempts. Last error: boom`,
      reason: "maxRetriesExceeded",
      errors: [apiCall(statusCode), apiCall(statusCode), apiCall(statusCode)],
    })

  // Regression: the AI SDK wraps the underlying failure in AI_RetryError once
  // its internal maxRetries is exhausted. fromError() previously only matched a
  // bare APICallError, so a wrapped 5xx fell through to the generic
  // `e instanceof Error` branch and collapsed to an opaque UnknownError — which
  // SessionRetry.retryable() cannot classify, so the visible `type: "retry"`
  // banner never fired and the turn hung with a dead spinner.
  test("a wrapped 503 becomes a structured APIError, not UnknownError", () => {
    const out = MessageV2.fromError(retryWrapping(503), { providerID })
    expect(MessageV2.APIError.isInstance(out)).toBe(true)
    const api = out as MessageV2.APIError
    expect(api.data.statusCode).toBe(503)
    expect(api.data.responseBody).toInclude("model_not_found")
  })

  test("the unwrapped 503 is classified retryable (drives the retry banner)", () => {
    const out = MessageV2.fromError(retryWrapping(503), { providerID })
    expect(SessionRetry.retryable(out as ReturnType<NamedError["toObject"]>)).toBeTruthy()
  })

  test("uses the last underlying error when attempts had differing statuses", () => {
    const wrapped = new RetryError({
      message: "Failed after 2 attempts. Last error: boom",
      reason: "maxRetriesExceeded",
      errors: [apiCall(500), apiCall(502)],
    })
    // RetryError.lastError === errors[errors.length - 1], so the 502 wins.
    const out = MessageV2.fromError(wrapped, { providerID })
    expect(MessageV2.APIError.isInstance(out)).toBe(true)
    expect((out as MessageV2.APIError).data.statusCode).toBe(502)
  })
})

describe("isRetryableTransientError", () => {
  test("SSE read timed out string match", () => {
    expect(isRetryableTransientError(new Error("SSE read timed out"))).toBe(true)
  })

  test("ECONNRESET / EPIPE / ETIMEDOUT codes", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT"]) {
      const err = Object.assign(new Error("network"), { code })
      expect(isRetryableTransientError(err)).toBe(true)
    }
  })

  test("HTTP 429 / 5xx / 529 statuses", () => {
    for (const status of [429, 500, 502, 503, 504, 529]) {
      const err = Object.assign(new Error("http"), { status })
      expect(isRetryableTransientError(err)).toBe(true)
    }
  })

  test("status from response.status (sdk shape)", () => {
    const err = Object.assign(new Error("http"), { response: { status: 503 } })
    expect(isRetryableTransientError(err)).toBe(true)
  })

  test("status from statusCode (AI SDK APICallError shape)", () => {
    // APICallError exposes the HTTP status as `.statusCode`, not `.status`.
    // Before the fix this fell through and returned false.
    for (const statusCode of [429, 500, 502, 503, 504, 529]) {
      const err = Object.assign(new Error("api"), { statusCode })
      expect(isRetryableTransientError(err)).toBe(true)
    }
    const err400 = Object.assign(new Error("bad req"), { statusCode: 400 })
    expect(isRetryableTransientError(err400)).toBe(false)
  })

  test("non-transient errors return false", () => {
    expect(isRetryableTransientError(new Error("syntax error"))).toBe(false)
    expect(isRetryableTransientError("string not Error")).toBe(false)
    expect(isRetryableTransientError(undefined)).toBe(false)
    expect(isRetryableTransientError(null)).toBe(false)
    const err400 = Object.assign(new Error("bad req"), { status: 400 })
    expect(isRetryableTransientError(err400)).toBe(false)
  })
})

describe("retryable() with raw Error (Spec ③ P2 regression)", () => {
  test("SSE read timed out is retryable", () => {
    const rawErr = new Error("SSE read timed out")
    expect(retryable(rawErr as unknown as never)).toBeTruthy()
  })

  test("ECONNRESET raw Error is retryable", () => {
    const rawErr = Object.assign(new Error("conn reset"), { code: "ECONNRESET" })
    expect(retryable(rawErr as unknown as never)).toBeTruthy()
  })

  test("non-transient raw Error returns undefined (existing path)", () => {
    const rawErr = new Error("some user mistake")
    expect(retryable(rawErr as unknown as never)).toBeUndefined()
  })
})
