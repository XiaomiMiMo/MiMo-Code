import z from "zod"
import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { APICallError, RetryError } from "ai"
import { HOST_RETRY_CLASSES } from "@mimo-ai/shared/util/error"
import { isRetryableNetworkError, summarizeCause } from "@/provider/error"

export const RETRY_CLASSES = HOST_RETRY_CLASSES
export type RetryClass = (typeof RETRY_CLASSES)[number]
export type HostResponseMatch =
  | { readonly kind: "field"; readonly path: "error.code" | "biz_code" | "error.biz_code"; readonly value: string | number }
  | { readonly kind: "json"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: "empty" }

export interface HostErrorRule {
  readonly match: {
    readonly providerID: string
    readonly statusCode?: number
    readonly response: HostResponseMatch
  }
  readonly code: string
  readonly retryClass: RetryClass
}

export interface HostErrorCatalog {
  readonly protocolVersion: 2
  readonly rules: readonly HostErrorRule[]
}

const HostErrorRuleSchema = z.strictObject({
  match: z.strictObject({
    providerID: z.string().min(1),
    statusCode: z.number().int().min(100).max(599).optional(),
    response: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("field"), path: z.enum(["error.code", "biz_code", "error.biz_code"]), value: z.union([z.string(), z.number()]) }),
      z.strictObject({ kind: z.literal("json"), value: z.record(z.string(), z.json()) }),
      z.strictObject({ kind: z.literal("empty") }),
    ]),
  }).refine((match) => match.response.kind !== "empty" || match.statusCode !== undefined, "empty response requires statusCode"),
  code: z.string().min(1),
  retryClass: z.enum(RETRY_CLASSES),
})
const HostErrorCatalogSchema = z.strictObject({ protocolVersion: z.literal(2), rules: z.array(HostErrorRuleSchema) })

export function isRetryClass(value: unknown): value is RetryClass {
  return typeof value === "string" && RETRY_CLASSES.some((item) => item === value)
}

export const hostFieldShape = {
  hostCode: z.string().min(1).optional(),
  hostRetryClass: z.enum(RETRY_CLASSES).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
} as const

export function isHardTerminalStatus(status: number | undefined): boolean {
  return status === 400 || status === 401 || status === 402 || status === 403 || status === 413 || status === 422 || status === 501 || status === 505
}

export function isRetryableNotFound(error: unknown): boolean {
  const data = (error as { data?: { statusCode?: unknown; metadata?: { allow404Retry?: unknown } } } | null)?.data
  return data?.statusCode === 404 && data.metadata?.allow404Retry === "true"
}

const INVARIANT_NAMES = new Set([
  "MessageAbortedError", "ProviderAuthError", "ContextOverflowError", "AI_LoadAPIKeyError",
  "FreeUsageLimitError", "SubscriptionUsageLimitError",
])

export function isSafetyTerminal(error: unknown): boolean {
  return summarizeCause(error).some((cause) =>
    (cause.name === "AbortError" && cause.code !== "UND_ERR_ABORTED") || cause.code === "ABORT_ERR" ||
    (cause.name !== undefined && INVARIANT_NAMES.has(cause.name)),
  )
}

export function isTerminalError(error: unknown, allow404Retry = isRetryableNotFound(error)): boolean {
  if (error === null || typeof error !== "object") return false
  if (isSafetyTerminal(error)) return true
  if (summarizeCause(error).some((cause) =>
    isHardTerminalStatus(cause.statusCode) || (cause.statusCode === 404 && !allow404Retry),
  )) return true
  const e = error as { responseBody?: unknown; data?: { responseBody?: unknown; message?: unknown } }
  const body = e.data?.responseBody ?? e.responseBody ?? e.data?.message
  if (typeof body !== "string") return false
  if (body.includes("FreeUsageLimitError") || body.includes("SubscriptionUsageLimitError")) return true
  const parsed = json(body)
  const nested = record(parsed?.error)
  const code = nested?.code ?? nested?.type ?? parsed?.code
  return code === "insufficient_quota" || code === "usage_not_included"
}

export function retryConstraint(error: unknown): "terminal" | "network" | null {
  if (isTerminalError(error)) return "terminal"
  return isRetryableNetworkError(error) ? "network" : null
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

let snapshot: HostErrorCatalog = freeze({ protocolVersion: 2, rules: [] })

export function hostErrorCatalog(): HostErrorCatalog {
  return snapshot
}

export function loadHostErrorCatalog(doc: unknown): { ok: true } | { ok: false; reason: string } {
  const parsed = HostErrorCatalogSchema.safeParse(doc)
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") || "invalid catalog" }
  }
  snapshot = freeze(parsed.data)
  return { ok: true }
}

export function loadHostErrorCatalogFile(filePath: string): { ok: true } | { ok: false; reason: string } {
  try {
    return loadHostErrorCatalog(JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")))
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export function loadHostErrorCatalogFromEnv(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; reason: string } | null {
  return env.HOST_ERROR_CATALOG ? loadHostErrorCatalogFile(env.HOST_ERROR_CATALOG) : null
}

let environmentLoaded = false

export function initializeHostErrorCatalog(): void {
  if (environmentLoaded || !process.env.HOST_ERROR_CATALOG) return
  environmentLoaded = true
  const result = loadHostErrorCatalogFromEnv()
  if (result && !result.ok) console.warn(`[host-error-registry] catalog rejected: ${result.reason}`)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function json(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return record(value)
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

type APIResponse = { statusCode?: number; responseBody?: string }
type Binding = { rule: HostErrorRule | null; response?: APIResponse }
const bindings = new WeakMap<object, Map<string, Binding>>()

function apiResponse(error: unknown, seen = new Set<object>()): APIResponse | undefined {
  if (error === null || typeof error !== "object" || seen.has(error)) return
  seen.add(error)
  if (RetryError.isInstance(error)) return apiResponse(error.lastError ?? error.errors.at(-1), seen)
  if (APICallError.isInstance(error)) {
    if (error.statusCode === undefined && error.responseBody === undefined) return
    return { statusCode: error.statusCode, responseBody: error.responseBody }
  }
  if (error instanceof Error) return
  const body = record(error)
  const frame = record(body?.data)
  const response = frame?.type === "error" ? frame : body
  if (response?.type === "error" && (record(response.error) || typeof response.error === "string" || response.biz_code !== undefined)) {
    return { responseBody: JSON.stringify(response) }
  }
}

export function bindHostError<T>(error: T, context: { providerID: string }, response = apiResponse(error)): T {
  if (error === null || typeof error !== "object") return error
  if (bindings.get(error)?.has(context.providerID)) return error
  const body = json(response?.responseBody)
  const rule = response && !isSafetyTerminal(error) ? snapshot.rules.find((rule) => {
    if (rule.match.providerID !== context.providerID) return false
    if (rule.match.statusCode !== undefined && rule.match.statusCode !== response.statusCode) return false
    const match = rule.match.response
    if (match.kind === "empty") return !response.responseBody?.trim()
    if (match.kind === "json") return isDeepStrictEqual(body, match.value)
    const value = match.path === "biz_code" ? body?.biz_code : record(body?.error)?.[match.path.slice(6)]
    return value === match.value
  }) ?? null : null
  const resolutions = bindings.get(error) ?? new Map<string, Binding>()
  resolutions.set(context.providerID, { rule, response })
  bindings.set(error, resolutions)
  return error
}

export function inheritHostError<T>(error: T, context: { providerID: string }, seen = new Set<object>()): T {
  if (error === null || typeof error !== "object" || seen.has(error)) return error
  if (bindings.get(error)?.has(context.providerID)) return error
  seen.add(error)
  if (!RetryError.isInstance(error)) return error
  const inner = inheritHostError(error.lastError ?? error.errors.at(-1), context, seen)
  if (inner === null || typeof inner !== "object") return error
  const binding = bindings.get(inner)?.get(context.providerID)
  if (!binding) return error
  const resolutions = bindings.get(error) ?? new Map<string, Binding>()
  resolutions.set(context.providerID, binding)
  bindings.set(error, resolutions)
  return error
}

export function boundAPIResponse(error: unknown, context: { providerID: string }): APIResponse | undefined {
  if (error === null || typeof error !== "object") return
  const binding = bindings.get(error)?.get(context.providerID)
  return binding?.rule ? binding.response : undefined
}

export function copyHostError<T extends { name: string; data: { hostCode?: string; hostRetryClass?: string } }>(target: T, original: unknown, context: { providerID: string }): T {
  if (target.name !== "APIError" || original === null || typeof original !== "object") return target
  const binding = bindings.get(original)?.get(context.providerID)
  if (!binding) return target
  if (binding.rule) {
    target.data.hostCode = binding.rule.code
    target.data.hostRetryClass = isSafetyTerminal(original) ? "terminal" : binding.rule.retryClass
    return target
  }
  delete target.data.hostCode
  delete target.data.hostRetryClass
  return target
}

const malformedStampWarned = new Set<string>()

export function hostRetryClass(error: unknown): RetryClass | null {
  const e = record(error)
  if (e?.name !== "APIError") return null
  const data = record(e.data)
  if (typeof data?.hostCode !== "string" || !data.hostCode) return null
  if (isRetryClass(data.hostRetryClass)) return data.hostRetryClass
  if (!malformedStampWarned.has(data.hostCode)) {
    malformedStampWarned.add(data.hostCode)
    console.warn(`[host-error-registry] malformed stamp ${data.hostCode}; class → terminal`)
  }
  return "terminal"
}

export * as HostErrorRegistry from "./host-registry"
