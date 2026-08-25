import { describe, expect, test } from "bun:test"
import type { NamedError } from "@mimo-ai/shared/util/error"
import { APICallError, RetryError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Schedule, Schema } from "effect"
import { ConfigRetry } from "../../src/config/retry"
import { SessionRetry, decide, isRetryableTransientError, retryable } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID } from "../../src/provider/schema"
import { allowsModelNotFoundRetry } from "../../src/provider/error"
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
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.retryDelay(index + 1, decide(error), 0, 2000, 30_000))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.retryDelay(4, decide(error), 0, 2000, SessionRetry.RETRY_MAX_DELAY)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.retryDelay(3, decide(error), 0, 2000, SessionRetry.RETRY_MAX_DELAY)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.retryDelay(1, decide(error), 0, 2000, SessionRetry.RETRY_MAX_DELAY)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.retryDelay(1, decide(error), 0, 2000, 30_000)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.retryDelay(1, decide(error), 0, 2000, 30_000)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.retryDelay(1, decide(error), 0, 2000, 30_000)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.retryDelay(1, decide(error), 0, 2000, SessionRetry.RETRY_MAX_DELAY)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.retryDelay(1, decide(longError), 0, 2000, SessionRetry.RETRY_MAX_DELAY)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.retryDelay(1, decide(error), 0, 2000, SessionRetry.RETRY_MAX_DELAY)).toBe(SessionRetry.RETRY_MAX_DELAY)
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

  test("status retry attempts stay global across request and stream phases", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("session-retry-phase-counter")
        const result = await AppRuntime.runPromise(
          SessionStatus.Service.use((svc) =>
            Effect.gen(function* () {
              yield* svc.setRetry(sessionID, {
                type: "retry",
                attempt: 1,
                phaseAttempt: 1,
                message: "request",
                next: Date.now(),
                phase: "request",
                scope: "request",
              })
              yield* svc.set(sessionID, { type: "busy" })
              const attempt = yield* svc.setRetry(sessionID, {
                type: "retry",
                attempt: 1,
                phaseAttempt: 1,
                message: "stream",
                next: Date.now(),
                phase: "stream",
                scope: "live-step",
              })
              const status = yield* svc.get(sessionID)
              return { attempt, status }
            }),
          ),
        )
        expect(result.attempt).toBe(2)
        expect(result.status).toMatchObject({ type: "retry", attempt: 2, phaseAttempt: 1, phase: "stream" })
      },
    })
  })

  test("requires explicit noDeadline instead of deadlineMs zero", () => {
    const decode = Schema.decodeUnknownSync(ConfigRetry.Budget)
    expect(() => decode({ deadlineMs: 0 })).toThrow()
    expect(() => decode({ deadlineMs: 1000, noDeadline: true })).toThrow("deadlineMs and noDeadline cannot be configured together")
    expect(decode({ mode: "persistent", noDeadline: true })).toMatchObject({ noDeadline: true })
    expect(SessionRetry.resolve({ retry: { server: { maxRetries: 2, noDeadline: true } } }).server.maxElapsedMs).toBe(0)
    expect(
      SessionRetry.resolve(
        { retry: { server: { noDeadline: true } }, provider: { test: { retry: { server: { deadlineMs: 1000 } } } } },
        "test",
      ).server.maxElapsedMs,
    ).toBe(1000)
    expect(
      SessionRetry.resolve(
        { retry: { server: { deadlineMs: 1000 } }, provider: { test: { retry: { server: { noDeadline: true } } } } },
        "test",
      ).server.maxElapsedMs,
    ).toBe(0)
  })
})

describe("session.retry.retryable", () => {
  test("resolves persistent network defaults and provider overrides", () => {
    const resolved = SessionRetry.resolve({
      retry: {
        network: { mode: "bounded", maxRetries: 4, initialDelayMs: 100, maxDelayMs: 1000 },
        stream: { maxRetries: 9 },
      },
      provider: {
        test: { retry: { network: { mode: "persistent", deadlineMs: 60000 }, stream: { maxRetries: 12 } } },
      },
    }, "test")
    expect(resolved.network).toMatchObject({ mode: "persistent", maxRetries: undefined, maxElapsedMs: 60000, initialDelayMs: 100, maxDelayMs: 1000 })
    expect(resolved.stream.maxRetries).toBe(12)
  })

  test("selects a long network budget without widening request server retries", () => {
    const resolved = SessionRetry.resolve(undefined, "test")
    expect(SessionRetry.budgetFor(resolved, { retryable: true, phase: "stream", scope: "live-step", kind: "network", message: "reset" }).mode).toBe("persistent")
    expect(SessionRetry.budgetFor(resolved, { retryable: true, phase: "request", scope: "request", kind: "server", message: "503" }).maxRetries).toBe(4)
    expect(SessionRetry.budgetFor(resolved, { retryable: true, phase: "request", scope: "request", kind: "network", message: "reset" }).maxRetries).toBe(4)
    expect(resolved.unknown).toMatchObject({ maxRetries: 8, maxElapsedMs: 15 * 60_000 })
    expect(resolved.request.jitterRatio).toBe(0.1)
    expect(resolved.network.jitterRatio).toBe(0)
  })

  test("caps retry-after by the selected budget", () => {
    const decision = { retryable: true, phase: "stream" as const, scope: "live-step" as const, kind: "rate_limit" as const, message: "429", retryAfterMs: 120000 }
    expect(SessionRetry.retryDelay(1, decision, 0, 100, 5000)).toBe(5000)
  })

  test("parses retry hints with the declared units", () => {
    const error = new MessageV2.APIError({ message: "Please retry in 1 millisecond", statusCode: 429, isRetryable: false }).toObject()
    expect(decide(error).retryAfterMs).toBe(100)
    expect(decide(new MessageV2.APIError({ message: "Please retry in 5s", statusCode: 429, isRetryable: false }).toObject()).retryAfterMs).toBe(5000)
    expect(decide(new MessageV2.APIError({ message: "Please retry in 5m", statusCode: 429, isRetryable: false }).toObject()).retryAfterMs).toBe(5 * 60_000)
    expect(decide(new MessageV2.APIError({ message: "Please retry in 1h", statusCode: 429, isRetryable: false }).toObject()).retryAfterMs).toBe(5 * 60_000)
  })

  test("rejects malformed retry-after-ms and floors zero delay", () => {
    const zero = new MessageV2.APIError({ message: "429", statusCode: 429, isRetryable: false, responseHeaders: { "retry-after-ms": "0" } }).toObject()
    const garbage = new MessageV2.APIError({ message: "429", statusCode: 429, isRetryable: false, responseHeaders: { "retry-after-ms": "10oops" } }).toObject()
    const negative = new MessageV2.APIError({ message: "429", statusCode: 429, isRetryable: false, responseHeaders: { "retry-after-ms": "-10" } }).toObject()
    expect(decide(zero).retryAfterMs).toBe(SessionRetry.RETRY_MIN_DELAY)
    expect(decide(garbage).retryAfterMs).toBeUndefined()
    expect(decide(negative).retryAfterMs).toBeUndefined()
  })

  test("does not retry deterministic 402, 501, or 505 responses", () => {
    for (const statusCode of [402, 501, 505]) {
      const error = new MessageV2.APIError({ message: "failure", statusCode, isRetryable: true }).toObject()
      expect(decide(error)).toMatchObject({ retryable: false, kind: "terminal", statusCode })
    }
  })

  test("only retries provider-specific compatible 404 responses", () => {
    const generic = new MessageV2.APIError({ message: "missing", statusCode: 404, isRetryable: true }).toObject()
    const compatible = new MessageV2.APIError({ message: "missing", statusCode: 404, isRetryable: true, metadata: { allow404Retry: "true" } }).toObject()
    expect(decide(generic)).toMatchObject({ retryable: false, kind: "terminal" })
    expect(decide(compatible)).toMatchObject({ retryable: true, kind: "unknown" })
    expect(allowsModelNotFoundRetry({ api: { npm: "@ai-sdk/openai-compatible" } })).toBe(true)
    expect(allowsModelNotFoundRetry({ api: { npm: "custom-provider" } })).toBe(false)
    expect(allowsModelNotFoundRetry({})).toBe(false)
  })

  test("jitter never exceeds the configured delay ceiling", () => {
    const decision = { retryable: true, phase: "stream" as const, scope: "live-step" as const, kind: "server" as const, message: "503" }
    for (let i = 0; i < 100; i++) expect(SessionRetry.retryDelay(1, decision, 1, 100, 100)).toBeLessThanOrEqual(100)
  })

  test("uses the 5-to-60-second network backoff without jitter", () => {
    const decision = { retryable: true, phase: "stream" as const, scope: "live-step" as const, kind: "network" as const, message: "connection failed" }
    const resolved = SessionRetry.resolve(undefined, "test")
    const budget = SessionRetry.budgetFor(resolved, decision)
    expect([1, 2, 3, 4, 5].map((attempt) => SessionRetry.retryDelay(attempt, decision, budget.jitterRatio, budget.initialDelayMs, budget.maxDelayMs))).toStrictEqual([5000, 10000, 20000, 40000, 60000])
  })

  test("recognizes GPT models by configured or API model ID", () => {
    expect(SessionRetry.isGptModel({ id: "gpt-5.2", api: { id: "gpt-5.2" } })).toBe(true)
    expect(SessionRetry.isGptModel({ id: "coding-model", api: { id: "gpt-5.2" } })).toBe(true)
    expect(SessionRetry.isGptModel({ id: "claude-sonnet-4", api: { id: "claude-sonnet-4" } })).toBe(false)
  })

  test("identifies the GPT server overloaded stream error exactly", () => {
    const body = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "service_unavailable_error",
        code: "server_is_overloaded",
        message: "Our servers are currently overloaded. Please try again later.",
        param: null,
      },
    }
    const error = new MessageV2.APIError({
      message: body.error.message,
      isRetryable: true,
      responseBody: JSON.stringify(body),
    }).toObject() as MessageV2.APIError

    expect(SessionRetry.isGptServerOverloadedError(error)).toBe(true)
    expect(
      SessionRetry.isGptServerOverloadedError({
        ...error,
        data: {
          ...error.data,
          responseBody: JSON.stringify({ ...body, error: { ...body.error, code: "server_error" } }),
        },
      }),
    ).toBe(false)
  })

  test("silently retries GPT overload three times before stopping", async () => {
    const error = new MessageV2.APIError({
      message: "Our servers are currently overloaded. Please try again later.",
      isRetryable: true,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "service_unavailable_error", code: "server_is_overloaded" },
      }),
    }).toObject() as MessageV2.APIError
    const visible: number[] = []
    let attempts = 0

    await expect(
      Effect.runPromise(
        Effect.suspend(() => {
          attempts++
          return Effect.fail(error)
        }).pipe(
          Effect.retry(
            SessionRetry.policy({
              parse: (input) => input as MessageV2.APIError,
              silentRetry: SessionRetry.isGptServerOverloadedError,
              initialDelayMs: 0,
              set: (info) => Effect.sync(() => visible.push(info.attempt)),
            }),
          ),
        ),
      ),
    ).rejects.toBe(error)
    expect(attempts).toBe(4)
    expect(visible).toEqual([2, 3])
  })

  test("retries OpenAI server_error stream events", () => {
    const input = {
      type: "error",
      sequence_number: 3,
      error: {
        type: "server_error",
        code: "server_error",
        message: "An error occurred while processing your request. You can retry your request.",
        param: null,
      },
    }
    const error = MessageV2.fromError(input, { providerID })

    expect(error).toStrictEqual({
      name: "APIError",
      data: {
        message: input.error.message,
        isRetryable: true,
        responseBody: JSON.stringify(input),
      },
    })
    expect(SessionRetry.retryable(error)).toBe(input.error.message)
  })

  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps provider 429 limitation error body as rate-limited", () => {
    const error = wrap(JSON.stringify({ error: { code: "429", message: "Too many requests", type: "limitation" } }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps numeric 429 error code as rate-limited", () => {
    const error = wrap(JSON.stringify({ error: { code: 429, message: "Too many requests" } }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps top-level 429 code as rate-limited", () => {
    const error = wrap(JSON.stringify({ code: "429", message: "slow down" }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps nested rate-limit message as rate-limited", () => {
    const error = wrap(JSON.stringify({ error: { code: "unknown", message: "Rate limit exceeded" } }))
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

  // T18: a 429 APIError the provider marked non-retryable previously fell
  // through the non-retryable bail (429 < 500) and surfaced as a raw blob.
  test("retries 429 APIError even when isRetryable is false (by status)", () => {
    const error = new MessageV2.APIError({
      message: '429: {"error":{"type":"rate_limit_error","message":"rate limited"}}',
      isRetryable: false,
      statusCode: 429,
      responseBody: '{"error":{"type":"rate_limit_error"}}',
    }).toObject() as MessageV2.APIError

    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("retries a rate-limit APIError when status is absent (by message/body)", () => {
    const error = new MessageV2.APIError({
      message: "provider error",
      isRetryable: false,
      responseBody: '{"error":{"type":"rate_limit_error"}}',
    }).toObject() as MessageV2.APIError

    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  // PR #1680 regression: FreeUsageLimitError arrives as an HTTP 429 whose body
  // also reads "Rate limit exceeded". It MUST surface the Go upsell prompt, not
  // be swallowed by the generic 429-retry branch into "Too Many Requests".
  test("FreeUsageLimitError over 429 returns the Go upsell, not Too Many Requests", () => {
    const error = new MessageV2.APIError({
      message: "429: Rate limit exceeded",
      isRetryable: false,
      statusCode: 429,
      responseBody: '{"type":"FreeUsageLimitError","message":"Rate limit exceeded"}',
    }).toObject() as MessageV2.APIError

    expect(SessionRetry.retryable(error)).toBe(SessionRetry.GO_UPSELL_MESSAGE)
  })

  // PR #1680 follow-up: SubscriptionUsageLimitError is also a terminal 429 —
  // retrying just hangs the session, so it must not become retryable.
  test("SubscriptionUsageLimitError over 429 is terminal (not retryable)", () => {
    const error = new MessageV2.APIError({
      message: "429: Rate limit exceeded",
      isRetryable: false,
      statusCode: 429,
      responseBody: '{"type":"SubscriptionUsageLimitError","message":"Rate limit exceeded"}',
    }).toObject() as MessageV2.APIError

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("isRateLimitMessage matches underscore rate_limit variants", () => {
    expect(SessionRetry.isRateLimitMessage("rate_limit_error")).toBe(true)
    expect(SessionRetry.isRateLimitMessage("too_many_requests")).toBe(true)
    expect(SessionRetry.isRateLimitMessage("something unrelated")).toBe(false)
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
  test("treats a normalized provider timeout as retryable", () => {
    const result = MessageV2.fromError(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" }), {
      providerID,
    })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect((result as MessageV2.APIError).data.metadata?.code).toBe("ETIMEDOUT")
    expect(SessionRetry.retryable(result as ReturnType<NamedError["toObject"]>)).toBeTruthy()
  })

  test("keeps AbortError terminal", () => {
    const result = MessageV2.fromError(new DOMException("The user aborted the request", "AbortError"), {
      providerID,
    })

    expect(MessageV2.AbortedError.isInstance(result)).toBe(true)
    expect(SessionRetry.retryable(result as ReturnType<NamedError["toObject"]>)).toBeUndefined()
  })

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
    const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai"), allow404Retry: true }) as MessageV2.APIError
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
    for (const code of [
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EAI_AGAIN",
      "EPIPE",
      "ETIMEDOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ]) {
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

  test("follows a wrapped network cause", () => {
    const cause = Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" })
    const error = Object.assign(new TypeError("fetch failed"), { cause })
    expect(isRetryableTransientError(error)).toBe(true)
  })

  test("does not retry an aborted request with a network cause", () => {
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
    const error = Object.assign(new DOMException("The user aborted the request", "AbortError"), { cause })
    expect(isRetryableTransientError(error)).toBe(false)
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

describe("retry decision and coordinator budget", () => {
 test("terminal abort wins over a retryable status in its cause chain", () => {
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
    const error = Object.assign(new DOMException("user aborted", "AbortError"), { cause, status: 503 })
   expect(decide(error)).toMatchObject({ retryable: false, kind: "terminal" })
 })

  test("treats an Undici transport abort as network-transient, not user abort", () => {
    const error = Object.assign(new Error("request aborted by transport"), { name: "AbortError", code: "UND_ERR_ABORTED" })
    expect(decide(error)).toMatchObject({ retryable: true, kind: "network" })
  })

  test("classifies quota exhaustion as terminal instead of a retry", () => {
    const error = new MessageV2.APIError({
      message: "Rate limit exceeded",
      statusCode: 429,
      isRetryable: false,
      responseBody: JSON.stringify({ type: "FreeUsageLimitError" }),
    }).toObject()
    expect(decide(error)).toMatchObject({ retryable: false, kind: "terminal", uiMessage: SessionRetry.GO_UPSELL_MESSAGE })
  })

  test("terminal UI notice is emitted without scheduling a retry", async () => {
    const error = new MessageV2.APIError({
      message: "Rate limit exceeded",
      statusCode: 429,
      isRetryable: false,
      responseBody: JSON.stringify({ type: "FreeUsageLimitError" }),
    }).toObject()
    let attempts = 0
    let notices = 0
    const schedule = SessionRetry.policy({
      onTerminal: (decision) => decision.uiMessage ? Effect.sync(() => notices++) : Effect.void,
      parse: (input) => input as ReturnType<NamedError["toObject"]>,
      set: () => Effect.void,
    })
    await expect(
      Effect.runPromise(Effect.suspend(() => { attempts++; return Effect.fail(error) }).pipe(Effect.retry(schedule))),
    ).rejects.toBe(error)
    expect(attempts).toBe(1)
    expect(notices).toBe(1)
  })

  test("caps natural-language retry delays and recognizes body-only rate limits", () => {
    const error = new MessageV2.APIError({
      message: "Try again in 24 hours",
      statusCode: 429,
      isRetryable: false,
      responseBody: JSON.stringify({ error: { code: "rate_limit_error", message: "Try again in 24 hours" } }),
    }).toObject()
    expect(decide(error)).toMatchObject({ retryable: true, kind: "rate_limit", retryAfterMs: 5 * 60_000 })
  })

  test("starts the retry deadline at the first failure, not policy construction", async () => {
    const error = new MessageV2.APIError({ message: "server", statusCode: 503, isRetryable: false }).toObject()
    let attempts = 0
    const schedule = SessionRetry.policy({
      maxElapsedMs: 10,
      initialDelayMs: 0,
      jitterRatio: 0,
      parse: (input) => input as ReturnType<NamedError["toObject"]>,
      set: () => Effect.void,
    })
    const result = await Effect.runPromise(Effect.suspend(() => Effect.gen(function* () {
      attempts++
      if (attempts === 1) { yield* Effect.sleep("20 millis"); return yield* Effect.fail(error) }
      return "ok"
    })).pipe(Effect.retry(schedule)))
    expect(result).toBe("ok")
    expect(attempts).toBe(2)
  })

  test("does not schedule a retry after the attempt crossed the side-effect boundary", async () => {
    const error = new MessageV2.APIError({ message: "server", statusCode: 503, isRetryable: false }).toObject()
    let attempts = 0
    let retryEvents = 0
    const schedule = SessionRetry.policy({
      phase: "stream",
      maxRetries: 5,
      replaySafe: () => false,
      parse: (input) => input as ReturnType<NamedError["toObject"]>,
      set: () => Effect.sync(() => retryEvents++),
    })

    await expect(
      Effect.runPromise(
        Effect.suspend(() => {
          attempts++
          return Effect.fail(error)
        }).pipe(Effect.retry(schedule)),
      ),
    ).rejects.toBe(error)
    expect(attempts).toBe(1)
    expect(retryEvents).toBe(0)
  })
})
