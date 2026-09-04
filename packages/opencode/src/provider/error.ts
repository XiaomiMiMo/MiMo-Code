import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderID } from "./schema"

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "EPIPE",
  "ENETDOWN",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_ABORTED",
  "UND_ERR_SOCKET",
])

const RETRYABLE_NETWORK_MESSAGES = [
  /^fetch failed$/i,
  /^SSE read timed out$/i,
  /connection (?:aborted|closed|refused|reset)(?: by server)?$/i,
  /network (?:connection|error)/i,
  /response body (?:terminated|closed)/i,
  /socket hang up/i,
]

export type CauseSummary = {
  depth: number
  name?: string
  message?: string
  code?: string
  statusCode?: number
  source: "cause" | "aggregate" | "root"
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const code = codeOf(error)
  if (code === "UND_ERR_ABORTED") return false
  return (error as { name?: unknown }).name === "AbortError" || code === "ABORT_ERR"
}

export function summarizeCause(input: unknown): CauseSummary[] {
  const seen = new Set<object>()
  const queue: Array<{ value: unknown; depth: number; source: CauseSummary["source"] }> = [
    { value: input, depth: 0, source: "root" },
  ]
  const result: CauseSummary[] = []
  while (queue.length > 0 && result.length < 16) {
    const node = queue.shift()!
    if (typeof node.value !== "object" || node.value === null || seen.has(node.value)) continue
    seen.add(node.value)
    const object = node.value as {
      name?: unknown
      message?: unknown
      code?: unknown
      status?: unknown
      statusCode?: unknown
      cause?: unknown
      errors?: unknown
    }
    const status = object.statusCode ?? object.status
    const statusCode = typeof status === "string" ? Number.parseInt(status, 10) : status
    result.push({
      depth: node.depth,
      name: typeof object.name === "string" ? object.name : undefined,
      message: typeof object.message === "string" ? object.message : undefined,
      code: typeof object.code === "string" ? object.code : undefined,
      statusCode: typeof statusCode === "number" && !Number.isNaN(statusCode) ? statusCode : undefined,
      source: node.source,
    })
    if (object.cause !== undefined && node.depth < 8)
      queue.push({ value: object.cause, depth: node.depth + 1, source: "cause" })
    if (Array.isArray(object.errors) && node.depth < 8) {
      for (const error of object.errors) queue.push({ value: error, depth: node.depth + 1, source: "aggregate" })
    }
  }
  return result
}
export function networkErrorCode(input: unknown): string | undefined {
  return summarizeCause(input)
    .map((cause) => cause.code)
    .find((code): code is string => code !== undefined && RETRYABLE_NETWORK_CODES.has(code))
}

export function isRetryableNetworkError(input: unknown): boolean {
  const chain = summarizeCause(input)
  if (chain.some((cause) => (cause.name === "AbortError" && cause.code !== "UND_ERR_ABORTED") || cause.code === "ABORT_ERR")) return false

  return chain.some((cause) => {
    const code = cause.code
    if (code && RETRYABLE_NETWORK_CODES.has(code)) return true
    const message = cause.message
    return message !== undefined && RETRYABLE_NETWORK_MESSAGES.some((pattern) => pattern.test(message))
  })
}

// Adapted from overflow detection patterns in:
// https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/overflow.ts
const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions + Responses API message text)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek, vLLM
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding, Moonshot
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /request entity too large/i, // HTTP 413
  /context length is only \d+ tokens/i, // vLLM
  /input length.*exceeds.*context length/i, // vLLM
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
]

function isApiErrorRetryable(e: APICallError, allow404Retry = false) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  return (status === 404 && allow404Retry) || e.isRetryable
}

const MODEL_NOT_FOUND_RETRY_ADAPTERS = new Set([
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/azure",
  "@ai-sdk/groq",
  "@ai-sdk/togetherai",
  "@openrouter/ai-sdk-provider",
  "@llmgateway/ai-sdk-provider",
])

export function allowsModelNotFoundRetry(model: { api?: { npm?: string } }): boolean {
  return typeof model.api?.npm === "string" && MODEL_NOT_FOUND_RETRY_ADAPTERS.has(model.api.npm)
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function isOverflow(message: string) {
  if (OVERFLOW_PATTERNS.some((p) => p.test(message))) return true

  // Providers/status patterns handled outside of regex list:
  // - Cerebras: often returns "400 (no body)" / "413 (no body)"
  // - Mistral: often returns "400 (no body)" / "413 (no body)"
  return /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)
}

// Provider IDs served by the MiMo model gateway. Its error bodies carry
// non-standard semantics (e.g. moderation/risk-control blocks under HTTP 400),
// so the gateway-specific handling below is scoped to these providers and leaves
// every other provider's error flow untouched.
const MIMO_GATEWAY_PROVIDERS = new Set(["xiaomi", "mimo"])

// MiMo gateway error.code values worth relabeling: moderation (421) and
// risk-control (441) blocks arrive under a generic HTTP 400.
const FRIENDLY_GATEWAY_CODES: Record<string, string> = {
  "421": "Request blocked by content moderation",
  "441": "Request blocked by risk control",
}

function message(providerID: ProviderID, e: APICallError) {
  return iife(() => {
    // MiMo gateway: relabel known block codes and surface error.param (the real
    // reason often lives there while error.message stays generic). json() returns
    // undefined for non-JSON, so HTML/proxy error pages fall through to the
    // original handling below.
    const gw = MIMO_GATEWAY_PROVIDERS.has(providerID) ? json(e.responseBody)?.error : undefined
    if (gw && typeof gw === "object") {
      const base = FRIENDLY_GATEWAY_CODES[String(gw.code)] ?? (typeof gw.message === "string" ? gw.message : "")
      if (base) return typeof gw.param === "string" && gw.param !== base ? `${base}: ${gw.param}` : base
    }

    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const body = json(input)
  if (!body) return

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") return

  switch (body?.error?.code || body?.error?.type) {
    case "overloaded_error":
    case "server_is_overloaded":
    case "server_error":
    case "stream_read_error":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body.error.message : "OpenAI server error",
        isRetryable: true,
        responseBody,
      }
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderID; error: APICallError; allow404Retry?: boolean }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  if (isOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = {
    providerID: input.providerID,
    allow404Retry: input.allow404Retry ? "true" : "false",
    ...(input.error.url ? { url: input.error.url } : {}),
  }
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: isApiErrorRetryable(input.error, input.allow404Retry),
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}
