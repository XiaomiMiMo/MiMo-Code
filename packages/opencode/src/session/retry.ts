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
    lower.includes("too_many_requests") ||
    lower.includes("rate limit") ||
    // Providers also spell it with an underscore in structured bodies/types
    // (e.g. "rate_limit_error", "rate_limited"). Prior fix only matched the
    // spaced form, so these slipped through into the raw TUI error. See T18.
    lower.includes("rate_limit") ||
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
    (error as { status?: number | string }).status ??
    (error as { statusCode?: number | string }).statusCode ??
    (error as { response?: { status?: number | string } }).response?.status
  // Some providers surface the HTTP status as a numeric string (e.g. "429")
  // rather than a number — coerce before matching so the 429 path is not missed.
  const statusNum = typeof status === "string" ? Number.parseInt(status, 10) : status
  if (typeof statusNum === "number" && !Number.isNaN(statusNum) && RETRYABLE_HTTP_STATUS.has(statusNum)) return true

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
    // Upstream processing failures (e.g. multimodal data corruption) return 400
    // but are transient — retry them.
    if (status === 400 && error.data.responseBody?.includes("upstream_error")) return error.data.message
    // Free-usage exhaustion is delivered as an HTTP 429 with a
    // `type:FreeUsageLimitError` body that also reads "Rate limit exceeded".
    // It is a TERMINAL, non-retryable condition — the user must subscribe to
    // Go. This MUST be checked before the generic 429-retry branch below,
    // otherwise the 429 branch swallows it into "Too Many Requests" + a
    // day-long retry-after and the upsell prompt is never shown. See PR #1680.
    if (error.data.responseBody?.includes("FreeUsageLimitError")) return GO_UPSELL_MESSAGE
    // Subscription (Go) usage exhaustion is also an HTTP 429 but is likewise
    // terminal — the plan's quota is spent, retrying just hangs the session.
    // Exclude it from the generic 429-retry path the same way.
    if (error.data.responseBody?.includes("SubscriptionUsageLimitError")) return undefined
    // 429 rate-limits are transient and retryable EVEN when the provider SDK
    // marked the APIError isRetryable:false (many do, expecting the caller to
    // honor retry-after). Prior fix (T7) only normalized 429s in the retry-status
    // and plaintext/JSON-message branches; a 429 APIError with isRetryable:false
    // fell through the non-retryable bail below (status 429 < 500), was never
    // retried, and surfaced as a raw blob in the TUI terminal error render
    // (errorBody prints error.data.message verbatim). Catch it here — by numeric
    // status OR a rate-limit signal in the message/body — before that bail so it
    // both retries and shows a clean status. See T18.
    if (
      status === 429 ||
      isRateLimitMessage(error.data.message) ||
      (typeof error.data.responseBody === "string" && isRateLimitMessage(error.data.responseBody))
    ) {
      return "Too Many Requests"
    }
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
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

  // Check for rate limit patterns in plain text error messages. Skip when the
  // message is a JSON object string — returning it here would leak the raw blob
  // into the TUI. Structured bodies are normalized by the JSON branch below.
  const msg = error.data?.message
  if (typeof msg === "string" && (!json || typeof json !== "object")) {
    if (isRateLimitMessage(msg)) {
      return msg
    }
  }
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  // Normalize any 429 / too-many-requests JSON shape into a retryable
  // rate-limit status. Providers disagree on where they put the signal:
  // top-level `type`/`code`, or nested under `error.{type,code,message}`.
  const errorCode = String(json.error?.code ?? "")
  const errorType = typeof json.error?.type === "string" ? json.error.type : ""
  const errorMessage = typeof json.error?.message === "string" ? json.error.message : ""
  const is429 = code === "429" || errorCode === "429" || String(json.status ?? "") === "429"
  if (
    errorType === "too_many_requests" ||
    is429 ||
    isRateLimitMessage(errorMessage) ||
    (typeof json.message === "string" && isRateLimitMessage(json.message))
  ) {
    return "Too Many Requests"
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return "Provider is overloaded"
  }
  if (json.type === "error" && errorCode.includes("rate_limit")) {
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
