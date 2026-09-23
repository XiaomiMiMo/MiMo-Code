import z from "zod"
import fs from "node:fs"
import path from "node:path"
import { isNamedErrorCreateName } from "@mimo-ai/shared/util/error"

/**
 * Generic host error registry: hosts inject a declarative birth-identity →
 * { code, retryClass } map. The engine stamps codes at error birth/normalization
 * and selects retry policy from the closed RetryClass set. Product copy stays
 * in the host. No host functions or message regex.
 */

export const RETRY_CLASSES = ["terminal", "network", "rate_limit", "server", "stream", "unknown"] as const
export type RetryClass = (typeof RETRY_CLASSES)[number]

export type BirthIdentity = `APIError:${number}` | `NamedError:${string}` | `ErrorName:${string}`

export interface HostErrorRule {
  code: string
  retryClass: RetryClass
}

export interface HostErrorCatalog {
  protocolVersion: 1
  rules: Record<BirthIdentity, HostErrorRule>
}

const BirthIdentityRe = /^(APIError:\d+|NamedError:[A-Za-z0-9_]+|ErrorName:[A-Za-z0-9_]+)$/

const HostErrorRuleSchema = z.object({
  code: z.string().min(1),
  retryClass: z.enum(RETRY_CLASSES),
})

// hostFieldShape is the additive data envelope for NamedError/APIError payloads.
// Catalog rules use HostErrorRuleSchema above; both share RETRY_CLASSES.

const HostErrorCatalogSchema = z.object({
  protocolVersion: z.literal(1),
  rules: z.record(z.string(), HostErrorRuleSchema),
})

const RETRY_CLASS_SET = new Set<string>(RETRY_CLASSES)

export function isRetryClass(value: unknown): value is RetryClass {
  return typeof value === "string" && RETRY_CLASS_SET.has(value)
}

export function isBirthIdentity(value: unknown): value is BirthIdentity {
  return typeof value === "string" && BirthIdentityRe.test(value)
}

/** Zod object extension for NamedError/APIError `data` payloads. */
export const hostFieldShape = {
  hostCode: z.string().min(1).optional(),
  hostRetryClass: z.enum(RETRY_CLASSES).optional(),
} as const

/**
 * Hard-terminal HTTP statuses — shared with decide() so stamp clamp and retry
 * policy cannot drift. **404 is not unconditional**: decide() treats
 * `metadata.allow404Retry === "true"` as retryable; clamp must not over-narrow.
 */
export function isHardTerminalStatus(status: number | undefined): boolean {
  if (status === undefined) return false
  return status === 400 || status === 401 || status === 402 || status === 403 || status === 422 || status === 501 || status === 505
}

/** True when a 404 may be retried (mirrors decide()). */
export function isRetryableNotFound(error: unknown): boolean {
  const data = (error as { data?: { statusCode?: unknown; metadata?: { allow404Retry?: unknown } } } | null)?.data
  const status = data?.statusCode
  return status === 404 && data?.metadata?.allow404Retry === "true"
}

/** NamedError.create names that are always terminal (abort / auth / overflow). */
const INVARIANT_NAMED = new Set([
  "MessageAbortedError",
  "ProviderAuthError",
  "ContextOverflowError",
])

/** ErrorName identities that are always terminal (usage-limit body signals without create names). */
const INVARIANT_ERROR_NAME = new Set(["FreeUsageLimitError", "SubscriptionUsageLimitError"])

export function isInvariantBirth(id: BirthIdentity): boolean {
  const bare = id.slice(id.indexOf(":") + 1)
  if (INVARIANT_NAMED.has(bare) || INVARIANT_ERROR_NAME.has(bare)) return true
  if (id.startsWith("APIError:")) return isHardTerminalStatus(Number(bare))
  return false
}

export function clampRetryClass(id: BirthIdentity, retryClass: RetryClass): RetryClass {
  return isInvariantBirth(id) ? "terminal" : retryClass
}

let snapshot: HostErrorCatalog = { protocolVersion: 1, rules: {} }

function freezeCatalog(catalog: HostErrorCatalog): HostErrorCatalog {
  return Object.freeze({
    protocolVersion: 1,
    rules: Object.freeze({ ...catalog.rules }),
  })
}

/** Current immutable snapshot. */
export function hostErrorCatalog(): HostErrorCatalog {
  return snapshot
}

/**
 * Validate + atomic replace. On reject, previous snapshot is kept.
 * Empty `rules: {}` is valid (clears bindings).
 */
export function loadHostErrorCatalog(doc: unknown): { ok: true } | { ok: false; reason: string } {
  const parsed = HostErrorCatalogSchema.safeParse(doc)
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") || "invalid catalog" }
  }
  const rules: Record<string, HostErrorRule> = {}
  for (const [key, value] of Object.entries(parsed.data.rules)) {
    if (!isBirthIdentity(key)) {
      return { ok: false, reason: `invalid birth identity: ${key}` }
    }
    if (!isRetryClass(value.retryClass) || !value.code) {
      return { ok: false, reason: `invalid rule for ${key}` }
    }
    rules[key] = { code: value.code, retryClass: value.retryClass }
  }
  snapshot = freezeCatalog({ protocolVersion: 1, rules: rules as HostErrorCatalog["rules"] })
  return { ok: true }
}

/** Load from an absolute JSON file path (child-process bootstrap). */
export function loadHostErrorCatalogFile(filePath: string): { ok: true } | { ok: false; reason: string } {
  try {
    const abs = path.resolve(filePath)
    const text = fs.readFileSync(abs, "utf8")
    return loadHostErrorCatalog(JSON.parse(text))
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Bootstrap helper: `HOST_ERROR_CATALOG` absolute path, if set. */
export function loadHostErrorCatalogFromEnv(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; reason: string } | null {
  const file = env.HOST_ERROR_CATALOG
  if (!file) return null
  return loadHostErrorCatalogFile(file)
}

/**
 * Fixed first-match birth identity from an original (pre-normalization) error
 * or an already-serialized `{name,data}` object.
 */
export function birthIdentity(error: unknown): BirthIdentity | null {
  if (error === null || typeof error !== "object") return null
  const e = error as {
    name?: unknown
    data?: { statusCode?: unknown; hostCode?: unknown }
    statusCode?: unknown
    status?: unknown
  }

  // Prefer structured data (serialized NamedError / APIError toObject shape).
  const dataStatus = e.data?.statusCode
  const rootStatus = e.statusCode ?? e.status
  const status = finiteInt(dataStatus) ?? finiteInt(rootStatus)

  const name = typeof e.name === "string" && e.name.length > 0 ? e.name : null

  // 1) APIError + numeric status (APIError is a NamedError named "APIError").
  if (name === "APIError" && status !== undefined) return `APIError:${status}`
  // 2) NamedError instance or registered create-name (single source: NamedError.create).
  const isNamedInstance =
    typeof (error as { toObject?: unknown }).toObject === "function" ||
    (name !== null && isNamedErrorCreateName(name))
  if (name && isNamedInstance) return `NamedError:${name}`
  // 3) Plain error.name (including TypeError and other host objects).
  if (name) return `ErrorName:${name}`
  return null
}

function finiteInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number.parseInt(value, 10)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export interface StampedErrorData {
  hostCode?: string
  hostRetryClass?: RetryClass
}

/**
 * Resolve rule for an error / serialized object. Does not mutate.
 */
export function resolveHostRule(error: unknown): HostErrorRule | null {
  const id = birthIdentity(error)
  if (!id) return null
  return snapshot.rules[id] ?? null
}

const malformedStampWarned = new Set<string>()

export function hostRetryClass(error: unknown): RetryClass | null {
  const data = hostDataOf(error)
  if (data?.hostCode) {
    if (isRetryClass(data.hostRetryClass)) return data.hostRetryClass
    // hostCode present but missing/invalid class → terminal (deterministic) + warn once per code.
    if (!malformedStampWarned.has(data.hostCode)) {
      malformedStampWarned.add(data.hostCode)
      console.warn(`[host-error-registry] malformed stamp ${data.hostCode}; class → terminal`)
    }
    return "terminal"
  }
  const rule = resolveHostRule(error)
  return rule?.retryClass ?? null
}

function hostDataOf(error: unknown): StampedErrorData | undefined {
  if (error === null || typeof error !== "object") return undefined
  const e = error as { data?: StampedErrorData } & StampedErrorData
  if (e.data && typeof e.data === "object") return e.data
  return e
}

/**
 * Stamp host fields at construction/normalization. Idempotent if `hostCode` already set.
 * Accepts NamedError instances (sets instance fields for toObject merge) or plain `{name,data}`.
 * Invariant identities are clamped to `terminal` with a one-line warn.
 */
export function stampHostError<T extends object>(target: T, original?: unknown): T {
  const existing = hostDataOf(target)
  if (existing?.hostCode) return target

  // Preserve stamp-once across fromError rebuilds: copy host fields from original first.
  const origData = original !== undefined ? hostDataOf(original) : undefined
  if (origData?.hostCode) {
    applyStamp(target, origData.hostCode, isRetryClass(origData.hostRetryClass) ? origData.hostRetryClass : "terminal")
    return target
  }

  const source = original !== undefined ? original : target
  const id = birthIdentity(source) ?? birthIdentity(target)
  const rule = resolveHostRule(source) ?? resolveHostRule(target)
  if (!rule || !id) return target

  let cls = clampRetryClass(id, rule.retryClass)
  // 404 + allow404Retry is the one conditional hard status: do not clamp to terminal.
  if (id.startsWith("APIError:") && Number(id.slice("APIError:".length)) === 404 && isRetryableNotFound(source)) {
    cls = rule.retryClass
  }
  if (cls !== rule.retryClass) {
    console.warn(`[host-error-registry] clamped ${rule.code} (${id}) to terminal`)
  }
  applyStamp(target, rule.code, cls)
  return target
}

function applyStamp(target: object, code: string, retryClass: RetryClass): void {
  const t = target as {
    data?: Record<string, unknown>
    hostCode?: string
    hostRetryClass?: RetryClass
  }
  if (t.data && typeof t.data === "object") {
    t.data.hostCode = code
    t.data.hostRetryClass = retryClass
    return
  }
  // Instance-style NamedError before toObject()
  t.hostCode = code
  t.hostRetryClass = retryClass
  if (!t.data) {
    // ensure toObject can merge
    Object.defineProperty(t, "data", {
      value: {},
      enumerable: false,
      writable: true,
      configurable: true,
    })
  }
}

export * as HostErrorRegistry from "./host-registry"
