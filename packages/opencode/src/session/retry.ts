import type { NamedError } from "@mimo-ai/shared/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export type Err = ReturnType<NamedError["toObject"]>

// This exported message is shared with the TUI upsell detector. Matching on a
// literal error string kind of sucks, but it is the simplest for now.
export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go https://opencode.ai/go"

// Shared with the TUI: does this retry status message indicate a rate-limit /
// queue ("too many requests" / HTTP 429) condition? retryable() normalizes
// every 429 variant into a message containing one of these substrings.
export function isRateLimitMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("rate increased too quickly")
  )
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT"])
const SSE_TIMEOUT_MESSAGE = "SSE read timed out"
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504, 529])

/**
 * Single source of truth for "is this transient and retryable?".
 *
 * Used by:
 * - `retryable()` below (processor-level Effect.retry policy via SessionRetry.policy)
 * - `isTransientCapacityError()` in llm.ts (LLM-internal retry around streamText)
 *
 * Both call sites previously had divergent logic — this hung sessions on
 * SSE timeouts that one path retried but the other dropped. See Spec ③.
 */
export function isRetryableTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const status =
    (error as { status?: number }).status ??
    (error as { statusCode?: number }).statusCode ??
    (error as { response?: { status?: number } }).response?.status
  if (typeof status === "number" && RETRYABLE_HTTP_STATUS.has(status)) return true

  const code = (error as { code?: string }).code
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true

  if (error.message === SSE_TIMEOUT_MESSAGE) return true

  return false
}

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: MessageV2.APIError) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export function retryable(error: Err) {
  // context overflow errors should not be retried
  if (MessageV2.ContextOverflowError.isInstance(error)) return undefined

  // Catch raw Error / network / SSE-timeout BEFORE APIError narrowing.
  // SessionRetry.policy unwraps Cause<unknown> via opts.parse, but raw
  // Error instances slip past the APIError check below. Adding this
  // branch closes that gap. See Spec ③ P2.
  if (isRetryableTransientError(error as unknown)) {
    const msg = (error as unknown as Error).message
    return msg || "Transient network error"
  }

  if (MessageV2.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) return GO_UPSELL_MESSAGE
    return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
  }

  // Check for rate limit patterns in plain text error messages
  const msg = error.data?.message
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return msg
    }
  }

  const json = iife(() => {
    try {
      if (typeof error.data?.message === "string") {
        const parsed = JSON.parse(error.data.message)
        return parsed
      }

      return JSON.parse(error.data.message)
    } catch {
      return undefined
    }
  })
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return "Too Many Requests"
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return "Provider is overloaded"
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return "Rate Limited"
  }
  return undefined
}

export function policy(opts: {
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const message = retryable(error)
      if (!message) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, MessageV2.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({ attempt: meta.attempt, message, next: now + wait })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
