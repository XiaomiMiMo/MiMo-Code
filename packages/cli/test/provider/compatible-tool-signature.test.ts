import { describe, expect, test } from "bun:test"
import type { SharedV3ProviderMetadata } from "@ai-sdk/provider"
import { captureCompatibleToolSignature } from "../../src/provider/compatible-tool-signature"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"

const compatibleModel = ProviderTest.model({
  id: ModelID.make("model"),
  providerID: ProviderID.make("my-proxy"),
  api: { id: "model", url: "https://example.com/v1", npm: "@ai-sdk/openai-compatible" },
})

describe("captureCompatibleToolSignature", () => {
  test("moves signature from exact or camelCase provider namespace to google", () => {
    const exact: SharedV3ProviderMetadata = { "my-proxy": { thoughtSignature: " sig-1 " } }
    expect(captureCompatibleToolSignature(exact, compatibleModel, "my-proxy.chat")).toEqual({
      google: { thoughtSignature: " sig-1 " },
    })

    const camelFromHyphen: SharedV3ProviderMetadata = { myProxy: { thoughtSignature: "sig-2" } }
    expect(captureCompatibleToolSignature(camelFromHyphen, compatibleModel, "my-proxy.chat")).toEqual({
      google: { thoughtSignature: "sig-2" },
    })

    const camelFromUnderscore: SharedV3ProviderMetadata = { myProxy: { thoughtSignature: "sig-3" } }
    expect(captureCompatibleToolSignature(camelFromUnderscore, compatibleModel, "my_proxy.chat")).toEqual({
      google: { thoughtSignature: "sig-3" },
    })
  })

  test("preserves sibling metadata keys under source and google namespaces", () => {
    const metadata: SharedV3ProviderMetadata = {
      myProxy: { thoughtSignature: "sig-4", extra: "keep-me" },
      google: { existing: true },
      other: { flag: 1 },
    }
    expect(captureCompatibleToolSignature(metadata, compatibleModel, "my-proxy.chat")).toEqual({
      myProxy: { extra: "keep-me" },
      google: { existing: true, thoughtSignature: "sig-4" },
      other: { flag: 1 },
    })
  })

  test("returns original metadata unchanged when already under google, invalid, or non-compatible", () => {
    const googleMeta: SharedV3ProviderMetadata = { google: { thoughtSignature: "sig-g" } }
    expect(captureCompatibleToolSignature(googleMeta, compatibleModel, "google.chat")).toBe(googleMeta)

    const emptySig: SharedV3ProviderMetadata = { myProxy: { thoughtSignature: "" } }
    expect(captureCompatibleToolSignature(emptySig, compatibleModel, "my-proxy.chat")).toBe(emptySig)

    const nonStringSig: SharedV3ProviderMetadata = { myProxy: { thoughtSignature: 42 } }
    expect(captureCompatibleToolSignature(nonStringSig, compatibleModel, "my-proxy.chat")).toBe(nonStringSig)

    const nativeModel = ProviderTest.model({
      api: { id: "model", url: "https://example.com/v1", npm: "@ai-sdk/openai" },
    })
    const otherMeta: SharedV3ProviderMetadata = { myProxy: { thoughtSignature: "sig-native" } }
    expect(captureCompatibleToolSignature(otherMeta, nativeModel, "my-proxy.chat")).toBe(otherMeta)
  })
})
