// Credential placement for Xiaomi MiMo platform keys (models.dev provider ids).
// API keys and token-plan keys live under different providers and may coexist.
// Endpoint hostname selects the store key; unknown endpoints fall back to `xiaomi`
// so legacy single-key entries keep working via the plugin loader's baseURL redirect.

export const XIAOMI_API_PROVIDER_ID = "xiaomi"

// hostname → provider id. Order is the credential fallback walk: token-plan clusters before API.
const GATEWAYS = [
  ["token-plan-cn.xiaomimimo.com", "xiaomi-token-plan-cn"],
  ["token-plan-ams.xiaomimimo.com", "xiaomi-token-plan-ams"],
  ["token-plan-sgp.xiaomimimo.com", "xiaomi-token-plan-sgp"],
  ["api.xiaomimimo.com", XIAOMI_API_PROVIDER_ID],
] as const

export const XIAOMI_CREDENTIAL_PROVIDER_IDS = GATEWAYS.map(([, id]) => id)

export function xiaomiProviderForEndpoint(url?: string): string {
  try {
    const host = url ? new URL(url).hostname.toLowerCase() : ""
    return GATEWAYS.find((gateway) => gateway[0] === host)?.[1] ?? XIAOMI_API_PROVIDER_ID
  } catch {
    return XIAOMI_API_PROVIDER_ID
  }
}

export function xiaomiDefaultBaseUrl(providerID: string): string | undefined {
  const gateway = GATEWAYS.find(([, id]) => id === providerID)
  return gateway ? `https://${gateway[0]}/v1` : undefined
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

/** Clears every family credential key (removing only `xiaomi` would leave token-plan entries). */
export async function removeXiaomiFamilyCredentials(remove: (providerID: string) => Promise<unknown> | unknown) {
  for (const providerID of XIAOMI_CREDENTIAL_PROVIDER_IDS) {
    await remove(providerID)
  }
}
