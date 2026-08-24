import type { NamedError } from "@mimo-ai/shared/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { ProviderError } from "@/provider"
import type { Budget as RetryBudgetConfig, Info as RetryConfig } from "@/config/retry"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go https://opencode.ai/go"
export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000
export const RETRY_MAX_DELAY_MESSAGE = 5 * 60_000
export const RETRY_MIN_DELAY = 100
export const RETRY_MAX_DELAY = 2_147_483_647
export const GPT_OVERLOAD_RETRIES = 3
export const REQUEST_MAX_RETRIES = 4
export const REQUEST_INITIAL_DELAY_MS = 200
export const STREAM_MAX_RETRIES = 5
export const REQUEST_RETRY_DEADLINE_MS = 30_000
export const STREAM_RETRY_DEADLINE_MS = 10 * 60_000
export const RETRY_JITTER_RATIO = 0.1
export const NETWORK_INITIAL_DELAY_MS = 5000
export const NETWORK_MAX_DELAY_MS = 60_000
export const SERVER_MAX_RETRIES = 8
export const SERVER_RETRY_DEADLINE_MS = 15 * 60_000
export const RATE_LIMIT_MAX_RETRIES = 5
// Provider-declared retryable errors without a known subtype deserve the same
// recovery window as server capacity errors; unknown means uncatalogued, not terminal.
export const UNKNOWN_MAX_RETRIES = SERVER_MAX_RETRIES
export const UNKNOWN_RETRY_DEADLINE_MS = SERVER_RETRY_DEADLINE_MS

export type RetryBudget = {
  mode: "bounded" | "persistent"
  maxRetries?: number
  maxElapsedMs: number
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

export type RetryConfigSource = {
  retry?: RetryConfig
  provider?: Record<string, { retry?: RetryConfig } | undefined>
}

export type ResolvedRetryConfig = {
  request: RetryBudget
  stream: RetryBudget
  maxCandidate: RetryBudget
  maxJudge: RetryBudget
  network: RetryBudget
  server: RetryBudget
  rateLimit: RetryBudget
  unknown: RetryBudget
  jitterRatio: number
}

const DEFAULT_RETRY_CONFIG: ResolvedRetryConfig = {
  request: {
    mode: "bounded",
    maxRetries: REQUEST_MAX_RETRIES,
    maxElapsedMs: REQUEST_RETRY_DEADLINE_MS,
    initialDelayMs: REQUEST_INITIAL_DELAY_MS,
    maxDelayMs: RETRY_MAX_DELAY_NO_HEADERS,
    jitterRatio: RETRY_JITTER_RATIO,
  },
  stream: {
    mode: "bounded",
    maxRetries: STREAM_MAX_RETRIES,
    maxElapsedMs: STREAM_RETRY_DEADLINE_MS,
    initialDelayMs: RETRY_INITIAL_DELAY,
    maxDelayMs: RETRY_MAX_DELAY_NO_HEADERS,
    jitterRatio: RETRY_JITTER_RATIO,
  },
  maxCandidate: {
    mode: "bounded",
    maxRetries: 3,
    maxElapsedMs: 3 * 60_000,
    initialDelayMs: 500,
    maxDelayMs: RETRY_MAX_DELAY_NO_HEADERS,
    jitterRatio: RETRY_JITTER_RATIO,
  },
  maxJudge: {
    mode: "bounded",
    maxRetries: 3,
    maxElapsedMs: 3 * 60_000,
    initialDelayMs: 500,
    maxDelayMs: RETRY_MAX_DELAY_NO_HEADERS,
    jitterRatio: RETRY_JITTER_RATIO,
  },
  network: {
    mode: "persistent",
    maxElapsedMs: 0,
    initialDelayMs: NETWORK_INITIAL_DELAY_MS,
    maxDelayMs: NETWORK_MAX_DELAY_MS,
    jitterRatio: 0,
  },
  server: {
    mode: "bounded",
    maxRetries: SERVER_MAX_RETRIES,
    maxElapsedMs: SERVER_RETRY_DEADLINE_MS,
    initialDelayMs: RETRY_INITIAL_DELAY,
    maxDelayMs: RETRY_MAX_DELAY_NO_HEADERS,
    jitterRatio: RETRY_JITTER_RATIO,
  },
  rateLimit: {
    mode: "bounded",
    maxRetries: RATE_LIMIT_MAX_RETRIES,
    maxElapsedMs: SERVER_RETRY_DEADLINE_MS,
    initialDelayMs: RETRY_INITIAL_DELAY,
    maxDelayMs: RETRY_MAX_DELAY_MESSAGE,
    jitterRatio: RETRY_JITTER_RATIO,
  },
  unknown: {
    mode: "bounded",
    maxRetries: UNKNOWN_MAX_RETRIES,
    maxElapsedMs: UNKNOWN_RETRY_DEADLINE_MS,
    initialDelayMs: RETRY_INITIAL_DELAY,
    maxDelayMs: RETRY_MAX_DELAY_NO_HEADERS,
    jitterRatio: RETRY_JITTER_RATIO,
  },
  jitterRatio: RETRY_JITTER_RATIO,
}

function mergeBudget(base: RetryBudget, ...overrides: (RetryBudgetConfig | undefined)[]): RetryBudget {
  const merged = overrides.reduce<RetryBudgetConfig>((result, override) => ({ ...result, ...override }), {})
  const rest = { ...merged }
  delete rest.deadlineMs
  delete rest.noDeadline
  const deadlineOverride = overrides.reduce<RetryBudgetConfig | undefined>(
    (result, override) =>
      override && (override.deadlineMs !== undefined || override.noDeadline !== undefined) ? override : result,
    undefined,
  )
  const result = {
    ...base,
    ...rest,
    ...(deadlineOverride?.deadlineMs !== undefined ? { maxElapsedMs: deadlineOverride.deadlineMs } : {}),
    ...(deadlineOverride?.noDeadline === true ? { maxElapsedMs: 0 } : {}),
  }
  return result.mode === "persistent" ? { ...result, maxRetries: undefined } : result
}

export function resolve(config: RetryConfigSource | undefined, providerID?: string): ResolvedRetryConfig {
  const global = config?.retry
  const provider = providerID ? config?.provider?.[providerID]?.retry : undefined
  return {
    request: mergeBudget(DEFAULT_RETRY_CONFIG.request, global?.request, provider?.request),
    stream: mergeBudget(DEFAULT_RETRY_CONFIG.stream, global?.stream, provider?.stream),
    maxCandidate: mergeBudget(DEFAULT_RETRY_CONFIG.maxCandidate, global?.maxCandidate, provider?.maxCandidate),
    maxJudge: mergeBudget(DEFAULT_RETRY_CONFIG.maxJudge, global?.maxJudge, provider?.maxJudge),
    network: mergeBudget(DEFAULT_RETRY_CONFIG.network, global?.network, provider?.network),
    server: mergeBudget(DEFAULT_RETRY_CONFIG.server, global?.server, provider?.server),
    rateLimit: mergeBudget(DEFAULT_RETRY_CONFIG.rateLimit, global?.rateLimit, provider?.rateLimit),
    unknown: mergeBudget(DEFAULT_RETRY_CONFIG.unknown, global?.unknown, provider?.unknown),
    jitterRatio: provider?.jitterRatio ?? global?.jitterRatio ?? DEFAULT_RETRY_CONFIG.jitterRatio,
  }
}

export function budgetFor(config: ResolvedRetryConfig, decision: RetryDecision): RetryBudget {
  if (decision.phase === "request") return config.request
  if (decision.kind === "network") return config.network
  if (decision.scope === "max-candidate") return config.maxCandidate
  if (decision.scope === "max-judge") return config.maxJudge
  if (decision.kind === "server") return config.server
  if (decision.kind === "rate_limit") return config.rateLimit
  if (decision.kind === "unknown") return config.unknown
  return config.stream
}

export type RetryPhase = "request" | "stream"
export type RetryScope = "request" | "live-step" | "max-candidate" | "max-judge"
export type RetryKind = "network" | "rate_limit" | "server" | "stream" | "unknown" | "terminal"
export type RetryDecision = {
  retryable: boolean
  phase: RetryPhase
  scope: RetryScope
  kind: RetryKind
  message: string
  uiMessage?: string
  statusCode?: number
  retryAfterMs?: number
}

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429])
const SSE_TIMEOUT_MESSAGE = "SSE read timed out"

export function isRateLimitMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes("too many requests") ||
    lower.includes("too_many_requests") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("rate limited") ||
    lower.includes("rate increased too quickly")
  )
}

function cap(ms: number) {
  return Math.min(Math.max(0, ms), RETRY_MAX_DELAY)
}

function capRetryHint(ms: number) {
  return Math.min(Math.max(RETRY_MIN_DELAY, ms), RETRY_MAX_DELAY)
}

function parseBody(input: unknown): Record<string, any> | undefined {
  if (typeof input !== "string") return undefined
  try {
    const parsed = JSON.parse(input)
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const value =
    (error as { statusCode?: number | string }).statusCode ??
    (error as { status?: number | string }).status ??
    (error as { data?: { statusCode?: number | string } }).data?.statusCode ??
    (error as { response?: { status?: number | string } }).response?.status
  const status = typeof value === "string" ? Number.parseInt(value, 10) : value
  return typeof status === "number" && !Number.isNaN(status) ? status : undefined
}

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
    const dataMessage = (error as { data?: { message?: unknown } }).data?.message
    if (typeof dataMessage === "string") return dataMessage
  }
  const summary = ProviderError.summarizeCause(error)[0]
  return summary?.message || summary?.name || "Provider request failed"
}

function responseBodyOf(error: unknown): string | undefined {
  if (MessageV2.APIError.isInstance(error)) return error.data.responseBody
  if (typeof error === "object" && error !== null) {
    const body = (error as { responseBody?: unknown }).responseBody
    const dataMessage = (error as { data?: { message?: unknown } }).data?.message
    if (typeof dataMessage === "string") return dataMessage
    return typeof body === "string" ? body : undefined
  }
  return undefined
}

function retryAfterValue(value: string): number | undefined {
  const normalized = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return capRetryHint(Math.ceil(Number.parseFloat(normalized) * 1000))
  const date = Date.parse(normalized) - Date.now()
  return !Number.isNaN(date) && date > 0 ? capRetryHint(Math.ceil(date)) : undefined
}

function retryAfterFromHeaders(error: MessageV2.APIError): number | undefined {
  const headers = error.data.responseHeaders
  if (!headers) return undefined
  const retryAfterMs = headers["retry-after-ms"]?.trim()
  if (retryAfterMs && /^\d+(?:\.\d+)?$/.test(retryAfterMs)) {
    return capRetryHint(Math.ceil(Number.parseFloat(retryAfterMs)))
  }
  const retryAfter = headers["retry-after"]
  return retryAfter ? retryAfterValue(retryAfter) : undefined
}

function retryAfterFromMessage(message: string): number | undefined {
  const match = message.match(
    /(?:try again|retry(?:ing)?)(?: in| after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)/i,
  )
  if (!match) return undefined
  const value = Number.parseFloat(match[1])
  const unit = match[2].toLowerCase()
  const multiplier = unit === "ms" || unit.startsWith("millisecond") ? 1 : unit === "s" || unit.startsWith("second") ? 1000 : unit === "m" || unit.startsWith("minute") ? 60_000 : 3_600_000
  return Math.min(capRetryHint(Math.ceil(value * multiplier)), RETRY_MAX_DELAY_MESSAGE)
}

function bodySignals(body: Record<string, any> | undefined) {
  const code = String(body?.error?.code ?? body?.code ?? "")
  const type = String(body?.error?.type ?? body?.type ?? "")
  const message = String(body?.error?.message ?? body?.message ?? "")
  return { code, type, message }
}

export function decide(
  error: unknown,
  phase: RetryPhase = "stream",
  scope: RetryScope = phase === "request" ? "request" : "live-step",
): RetryDecision {
  if (error === null || typeof error !== "object")
    return { retryable: false, phase, scope, kind: "terminal", message: String(error) }
  if (MessageV2.ContextOverflowError.isInstance(error)) {
    return { retryable: false, phase, scope, kind: "terminal", message: "Context window exceeded" }
  }
  if (MessageV2.AbortedError.isInstance(error)) {
    return { retryable: false, phase, scope, kind: "terminal", message: error.data.message }
  }
  if (MessageV2.AuthError.isInstance(error)) {
    return { retryable: false, phase, scope, kind: "terminal", message: error.data.message }
  }
  if (
    !(error instanceof Error) &&
    !MessageV2.APIError.isInstance(error) &&
    !(typeof (error as { data?: { message?: unknown } }).data?.message === "string")
  ) {
    return { retryable: false, phase, scope, kind: "terminal", message: messageOf(error) }
  }
  if (
    ProviderError.summarizeCause(error).some(
      (cause) => (cause.name === "AbortError" && cause.code !== "UND_ERR_ABORTED") || cause.code === "ABORT_ERR",
    )
  ) {
    return { retryable: false, phase, scope, kind: "terminal", message: messageOf(error) }
  }

  const status = statusOf(error)
  const responseBody = responseBodyOf(error)
  const signals = bodySignals(parseBody(responseBody))
  const message = messageOf(error)
  const retryAfterMs = MessageV2.APIError.isInstance(error)
    ? (retryAfterFromHeaders(error) ?? retryAfterFromMessage(message))
    : retryAfterFromMessage(message)
  const retry = (kind: RetryKind, retryPhase = phase, retryMessage = message): RetryDecision => ({
    retryable: true,
    phase: retryPhase,
    scope,
    kind,
    message: retryMessage || "Transient provider failure",
    statusCode: status,
    retryAfterMs,
  })
  const terminal = (terminalMessage = message, uiMessage?: string): RetryDecision => ({
    retryable: false,
    phase,
    scope,
    kind: "terminal",
    message: terminalMessage || "Provider request failed",
    ...(uiMessage ? { uiMessage } : {}),
    statusCode: status,
  })

  if (signals.code === "FreeUsageLimitError" || responseBody?.includes("FreeUsageLimitError"))
    return terminal("Usage limit reached", GO_UPSELL_MESSAGE)
  if (signals.code === "SubscriptionUsageLimitError" || responseBody?.includes("SubscriptionUsageLimitError"))
    return terminal()
  if (status === 402 || status === 501 || status === 505) return terminal()
  if (status === 404 && (!MessageV2.APIError.isInstance(error) || error.data.metadata?.allow404Retry !== "true")) return terminal()
  if (signals.code === "stream_read_error" || signals.type === "upstream_error")
    return retry("stream", "stream", signals.message || "Upstream stream read failed")
  if (ProviderError.isRetryableNetworkError(error)) return retry("network")
  if (message === SSE_TIMEOUT_MESSAGE) return retry("stream", "stream", message)
  if (
    signals.type === "too_many_requests" ||
    signals.type.includes("rate_limit") ||
    signals.code.includes("rate_limit") ||
    signals.code === "429" ||
    isRateLimitMessage(signals.message)
  )
    return retry("rate_limit", phase, "Too Many Requests")
  if (isRateLimitMessage(message)) return retry("rate_limit", phase, message)
  if (signals.code.includes("exhausted") || signals.code.includes("unavailable"))
    return retry("server", phase, "Provider is overloaded")
  if (status !== undefined && (RETRYABLE_HTTP_STATUS.has(status) || (status >= 500 && status <= 599 && status !== 501 && status !== 505)))
    return retry(status === 429 ? "rate_limit" : "server")
  if (MessageV2.APIError.isInstance(error)) {
    if (status === 400 || status === 401 || status === 403 || status === 422) return terminal()
    if (error.data.isRetryable) return retry("unknown")
  }
  return terminal()
}

export function isRetryableTransientError(error: unknown): boolean {
  return decide(error, "stream").retryable
}

export function retryDelay(
  attempt: number,
  decision: RetryDecision,
  jitterRatio = RETRY_JITTER_RATIO,
  initialDelayMs = RETRY_INITIAL_DELAY,
  maxDelayMs = RETRY_MAX_DELAY,
) {
  if (decision.retryAfterMs !== undefined) return Math.min(maxDelayMs, Math.max(RETRY_MIN_DELAY, decision.retryAfterMs))
  const base = Math.min(maxDelayMs, initialDelayMs * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
  if (jitterRatio <= 0) return base
  const factor = 1 + (Math.random() * 2 - 1) * jitterRatio
  return Math.min(maxDelayMs, Math.max(RETRY_MIN_DELAY, Math.round(base * factor)))
}

export function retryable(error: Err) {
  const result = decide(error, "stream")
  if (result.retryable || result.message === GO_UPSELL_MESSAGE || result.uiMessage === GO_UPSELL_MESSAGE)
    return result.uiMessage ?? result.message
  return undefined
}

export function isGptServerOverloadedError(error: Err): boolean {
  if (!MessageV2.APIError.isInstance(error) || !error.data.responseBody) return false
  const body = parseBody(error.data.responseBody)
  return (
    body?.type === "error" &&
    body?.error?.type === "service_unavailable_error" &&
    body?.error?.code === "server_is_overloaded"
  )
}

export function isGptModel(model: { id: string; api: { id: string } }): boolean {
  return [model.id, model.api.id].some((id) => id.toLowerCase().startsWith("gpt-"))
}

export function policy(opts: {
  parse: (error: unknown) => Err
  set: (input: {
    attempt: number
    message: string
    next: number
    maxAttempts: number
    phase: RetryPhase
    scope: RetryScope
    kind: RetryKind
  }) => Effect.Effect<void>
  phase?: RetryPhase
  scope?: RetryScope
  maxRetries?: number
  maxElapsedMs?: number
  jitterRatio?: number
  initialDelayMs?: number
  budget?: (decision: RetryDecision) => RetryBudget
  replaySafe?: (decision: RetryDecision) => boolean
  onTerminal?: (decision: RetryDecision) => Effect.Effect<void>
  silentRetry?: (error: Err) => boolean
}) {
  const phase = opts.phase ?? "stream"
  const scope = opts.scope ?? (phase === "request" ? "request" : "live-step")
  let startedAt: number | undefined
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const decision = decide(error, phase, scope)
      if (!decision.retryable) {
        return opts.onTerminal
          ? Effect.flatMap(opts.onTerminal(decision), () => Cause.done(meta.attempt))
          : Cause.done(meta.attempt)
      }
      const selected = opts.budget?.(decision)
      const budget: RetryBudget = selected ?? {
        mode: "bounded",
        maxRetries: opts.maxRetries ?? (phase === "request" ? REQUEST_MAX_RETRIES : STREAM_MAX_RETRIES),
        maxElapsedMs: opts.maxElapsedMs ?? (phase === "request" ? REQUEST_RETRY_DEADLINE_MS : STREAM_RETRY_DEADLINE_MS),
        initialDelayMs: opts.initialDelayMs ?? (phase === "request" ? REQUEST_INITIAL_DELAY_MS : RETRY_INITIAL_DELAY),
        maxDelayMs: RETRY_MAX_DELAY_NO_HEADERS,
        jitterRatio: opts.jitterRatio ?? RETRY_JITTER_RATIO,
      }
      if (
        opts.replaySafe?.(decision) === false ||
        (budget.mode === "bounded" && budget.maxRetries !== undefined && meta.attempt > budget.maxRetries)
      )
        return Cause.done(meta.attempt)
      const silent = opts.silentRetry?.(error) === true
      if (silent && meta.attempt > GPT_OVERLOAD_RETRIES) return Cause.done(meta.attempt)
      if (silent && meta.attempt === 1)
        return Effect.succeed([meta.attempt, Duration.zero] as [number, Duration.Duration])
      const now = Date.now()
      if (startedAt === undefined) startedAt = now
      const elapsed = now - startedAt
      const wait = retryDelay(meta.attempt, decision, budget.jitterRatio, budget.initialDelayMs, budget.maxDelayMs)
      if (budget.maxElapsedMs > 0 && (elapsed >= budget.maxElapsedMs || wait >= budget.maxElapsedMs - elapsed))
        return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: decision.message,
          next: now + wait,
          maxAttempts: budget.maxRetries ?? 0,
          phase: decision.phase,
          scope: decision.scope,
          kind: decision.kind,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
