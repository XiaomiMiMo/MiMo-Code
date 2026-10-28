// MiMo 开放平台凭据的 provider 归属（models.dev 目录 id）。
// API Key 与 Token Plan 是不同 provider，凭据分键存放、可共存；
// 落盘键按平台回调返回的端点 hostname 归类，未知端点回落 `xiaomi` 并保留
// metadata.base_url（插件 loader 重定向），兼容旧 CLI 形态条目。
// 族判据与 provider/error.ts 的网关族规则同形（`xiaomi` + `xiaomi-*`）。

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

/** Token Plan 档在前，API 档收尾——与桌面端语音回退次序一致。 */
export const XIAOMI_CREDENTIAL_PROVIDER_IDS = [
  XIAOMI_TOKEN_PLAN_CN,
  XIAOMI_TOKEN_PLAN_AMS,
  XIAOMI_TOKEN_PLAN_SGP,
  XIAOMI_API_PROVIDER_ID,
] as const

/** 登出清族内全部凭据键（API 与 Token Plan 分键存放，只清 `xiaomi` 会留下 Token Plan 条目）。 */
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
 * 旧 CLI 形态：凭据写在 `xiaomi` 键下、靠 `metadata.base_url` 指向 Token Plan 档。
 * 返回它实际归属的 Token Plan provider id；不是该形态（或归 API 档）返回 undefined。
 * 分键写入 Token Plan 档时据此清掉同一档的旧键，避免同一凭据双挂。
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
