import { describe, expect, test } from "bun:test"
import {
  XIAOMI_API_PROVIDER_ID,
  XIAOMI_CREDENTIAL_PROVIDER_IDS,
  isXiaomiFamilyProvider,
  legacyXiaomiAliasTarget,
  removeXiaomiFamilyCredentials,
  xiaomiDefaultBaseUrl,
  xiaomiProviderForEndpoint,
} from "../../src/provider/xiaomi-family"

const XIAOMI_TOKEN_PLAN_CN = "xiaomi-token-plan-cn"
const XIAOMI_TOKEN_PLAN_AMS = "xiaomi-token-plan-ams"
const XIAOMI_TOKEN_PLAN_SGP = "xiaomi-token-plan-sgp"

describe("xiaomiProviderForEndpoint", () => {
  test("maps the four trusted gateways to their catalog provider ids", () => {
    expect(xiaomiProviderForEndpoint("https://api.xiaomimimo.com/v1")).toBe(XIAOMI_API_PROVIDER_ID)
    expect(xiaomiProviderForEndpoint("https://token-plan-cn.xiaomimimo.com/v1")).toBe(XIAOMI_TOKEN_PLAN_CN)
    expect(xiaomiProviderForEndpoint("https://token-plan-ams.xiaomimimo.com/v1")).toBe(XIAOMI_TOKEN_PLAN_AMS)
    expect(xiaomiProviderForEndpoint("https://token-plan-sgp.xiaomimimo.com/v1")).toBe(XIAOMI_TOKEN_PLAN_SGP)
  })

  test("classifies by hostname regardless of path or trailing slash", () => {
    expect(xiaomiProviderForEndpoint("https://token-plan-cn.xiaomimimo.com")).toBe(XIAOMI_TOKEN_PLAN_CN)
    expect(xiaomiProviderForEndpoint("https://token-plan-ams.xiaomimimo.com/v1/")).toBe(XIAOMI_TOKEN_PLAN_AMS)
    expect(xiaomiProviderForEndpoint("https://api.xiaomimimo.com/v1/chat/completions")).toBe(XIAOMI_API_PROVIDER_ID)
  })

  test("falls back to the API provider for missing or unknown endpoints", () => {
    expect(xiaomiProviderForEndpoint(undefined)).toBe(XIAOMI_API_PROVIDER_ID)
    expect(xiaomiProviderForEndpoint("")).toBe(XIAOMI_API_PROVIDER_ID)
    expect(xiaomiProviderForEndpoint("not a url")).toBe(XIAOMI_API_PROVIDER_ID)
    expect(xiaomiProviderForEndpoint("https://gateway.example.com/v1")).toBe(XIAOMI_API_PROVIDER_ID)
  })
})

describe("isXiaomiFamilyProvider", () => {
  test("matches the API id and any xiaomi-* alias", () => {
    expect(isXiaomiFamilyProvider("xiaomi")).toBe(true)
    expect(isXiaomiFamilyProvider("xiaomi-token-plan-cn")).toBe(true)
    expect(isXiaomiFamilyProvider("xiaomi-token-plan-ams")).toBe(true)
    expect(isXiaomiFamilyProvider("xiaomi-token-plan-sgp")).toBe(true)
    expect(isXiaomiFamilyProvider("xiaomi-mimo-api")).toBe(true)
  })

  test("rejects other providers", () => {
    expect(isXiaomiFamilyProvider("mimo")).toBe(false)
    expect(isXiaomiFamilyProvider("mimo-desktop")).toBe(false)
    expect(isXiaomiFamilyProvider("openai")).toBe(false)
    expect(isXiaomiFamilyProvider("")).toBe(false)
    expect(isXiaomiFamilyProvider(undefined)).toBe(false)
    expect(isXiaomiFamilyProvider("myxiaomi")).toBe(false)
  })
})

describe("xiaomiDefaultBaseUrl", () => {
  test("returns the catalog endpoint per family provider", () => {
    expect(xiaomiDefaultBaseUrl(XIAOMI_API_PROVIDER_ID)).toBe("https://api.xiaomimimo.com/v1")
    expect(xiaomiDefaultBaseUrl(XIAOMI_TOKEN_PLAN_CN)).toBe("https://token-plan-cn.xiaomimimo.com/v1")
    expect(xiaomiDefaultBaseUrl(XIAOMI_TOKEN_PLAN_AMS)).toBe("https://token-plan-ams.xiaomimimo.com/v1")
    expect(xiaomiDefaultBaseUrl(XIAOMI_TOKEN_PLAN_SGP)).toBe("https://token-plan-sgp.xiaomimimo.com/v1")
    expect(xiaomiDefaultBaseUrl("openai")).toBeUndefined()
  })
})

describe("legacyXiaomiAliasTarget", () => {
  test("spots the legacy CLI form only when base_url maps to a token-plan cluster", () => {
    expect(legacyXiaomiAliasTarget({ type: "api", key: "k", metadata: { base_url: "https://token-plan-cn.xiaomimimo.com/v1" } })).toBe(XIAOMI_TOKEN_PLAN_CN)
    expect(legacyXiaomiAliasTarget({ type: "api", key: "k", metadata: { base_url: "https://token-plan-sgp.xiaomimimo.com/v1" } })).toBe(XIAOMI_TOKEN_PLAN_SGP)
    expect(legacyXiaomiAliasTarget({ type: "api", key: "k", metadata: { base_url: "https://api.xiaomimimo.com/v1" } })).toBeUndefined()
    expect(legacyXiaomiAliasTarget({ type: "api", key: "k", metadata: {} })).toBeUndefined()
    expect(legacyXiaomiAliasTarget({ type: "api", key: "k" })).toBeUndefined()
    expect(legacyXiaomiAliasTarget({ type: "oauth", refresh: "r", access: "a", expires: 0, metadata: { base_url: "https://token-plan-cn.xiaomimimo.com/v1" } })).toBeUndefined()
  })

  test("ignores malformed entries", () => {
    expect(legacyXiaomiAliasTarget(undefined)).toBeUndefined()
    expect(legacyXiaomiAliasTarget(null)).toBeUndefined()
    expect(legacyXiaomiAliasTarget("xiaomi")).toBeUndefined()
    expect(legacyXiaomiAliasTarget([])).toBeUndefined()
  })
})

describe("removeXiaomiFamilyCredentials", () => {
  test("removes all four family credential keys", async () => {
    const removed: string[] = []
    await removeXiaomiFamilyCredentials((providerID) => {
      removed.push(providerID)
    })
    expect(removed).toEqual([XIAOMI_TOKEN_PLAN_CN, XIAOMI_TOKEN_PLAN_AMS, XIAOMI_TOKEN_PLAN_SGP, XIAOMI_API_PROVIDER_ID])
  })
})
