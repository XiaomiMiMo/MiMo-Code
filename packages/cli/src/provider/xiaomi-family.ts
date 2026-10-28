// Credential placement for Xiaomi MiMo platform keys (models.dev provider ids).
// API keys and token-plan keys live under different providers and may coexist.
// Endpoint hostname selects the store key; unknown endpoints fall back to `xiaomi`
// so legacy single-key entries keep working via the plugin loader's baseURL redirect.

export const XIAOMI_API_PROVIDER_ID = "xiaomi"
export const XIAOMI_TOKEN_PLAN_CN = "xiaomi-token-plan-cn"
export const XIAOMI_TOKEN_PLAN_AMS = "xiaomi-token-plan-ams"
export const XIAOMI_TOKEN_PLAN_SGP = "xiaomi-token-plan-sgp"

const PROVIDER_BY_HOST: Record<string, string> = {
  "api.xiaomimimo.com": XIAOMI_API_PROVIDER_ID,
  "token-plan-cn.xiaomimimo.com": XIAOMI_TOKEN_PLAN_CN,
  "token-plan-ams.xiaomimimo.com": XIAOMI_TOKEN_PLAN_AMS,
  "token-plan-sgp.xiaomimimo.com": XIAOMI_TOKEN_PLAN_SGP,
}

const DEFAULT_BASE_URL_BY_PROVIDER: Record<string, string> = {
  [XIAOMI_API_PROVIDER_ID]: "https://api.xiaomimimo.com/v1",
  [XIAOMI_TOKEN_PLAN_CN]: "https://token-plan-cn.xiaomimimo.com/v1",
  [XIAOMI_TOKEN_PLAN_AMS]: "https://token-plan-ams.xiaomimimo.com/v1",
  [XIAOMI_TOKEN_PLAN_SGP]: "https://token-plan-sgp.xiaomimimo.com/v1",
}

/** Token-plan clusters first, API last — same walk order as the desktop voice fallback. */
export const XIAOMI_CREDENTIAL_PROVIDER_IDS = [
  XIAOMI_TOKEN_PLAN_CN,
  XIAOMI_TOKEN_PLAN_AMS,
  XIAOMI_TOKEN_PLAN_SGP,
  XIAOMI_API_PROVIDER_ID,
] as const

/** Clears every family credential key (removing only `xiaomi` would leave token-plan entries). */
export async function removeXiaomiFamilyCredentials(remove: (providerID: string) => Promise<unknown> | unknown) {
  for (const providerID of XIAOMI_CREDENTIAL_PROVIDER_IDS) {
    await remove(providerID)
  }
}

export function xiaomiProviderForEndpoint(url?: string): string {
  if (!url) return XIAOMI_API_PROVIDER_ID
  try {
    return PROVIDER_BY_HOST[new URL(url).hostname.toLowerCase()] ?? XIAOMI_API_PROVIDER_ID
  } catch {
    return XIAOMI_API_PROVIDER_ID
  }
}

export function xiaomiDefaultBaseUrl(providerID: string): string | undefined {
  return DEFAULT_BASE_URL_BY_PROVIDER[providerID]
}

export function isXiaomiFamilyProvider(providerID: string | undefined): boolean {
  const id = String(providerID ?? "")
  return id === XIAOMI_API_PROVIDER_ID || id.startsWith("xiaomi-")
}

/**
 * Legacy CLI form: a `xiaomi` api entry whose metadata.base_url points at a
 * token-plan cluster. Returns that cluster's id so a split write can drop the
 * stale key. Never matches oauth entries — those hold refresh tokens.
 */
export function legacyXiaomiAliasTarget(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
  const e = entry as { type?: unknown; metadata?: { base_url?: unknown } }
  if (e.type !== "api") return undefined
  const base = e.metadata && typeof e.metadata === "object" ? e.metadata.base_url : undefined
  if (typeof base !== "string" || !base) return undefined
  const target = xiaomiProviderForEndpoint(base)
  return target !== XIAOMI_API_PROVIDER_ID ? target : undefined
}
