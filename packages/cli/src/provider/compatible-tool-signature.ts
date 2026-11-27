import type { SharedV3ProviderMetadata } from "@ai-sdk/provider"
import type * as Provider from "./provider"

// SDK metadata namespaces end at the first dot. This private session key can
// never collide with a configured name, and is removed before SDK projection.
const stored = "mimocode.openai-compatible"

function sdkKeys(languageProvider: string) {
  const name = languageProvider.split(".")[0].trim()
  return [name, name.replace(/[_-]([a-z])/g, (_, letter: string) => letter.toUpperCase())]
}

function moveSignature(metadata: SharedV3ProviderMetadata, keys: string[], target?: string) {
  let result: SharedV3ProviderMetadata | undefined
  let signature: string | undefined
  for (const key of keys) {
    const source = (result ?? metadata)[key]
    if (!source || !Object.hasOwn(source, "thoughtSignature")) continue
    const { thoughtSignature, ...siblings } = source
    result ??= { ...metadata }
    if (Object.keys(siblings).length) result[key] = siblings
    else delete result[key]
    if (typeof thoughtSignature === "string" && thoughtSignature.length) signature ??= thoughtSignature
  }
  if (!result) return metadata
  if (target && signature) result[target] = { ...result[target], thoughtSignature: signature }
  return Object.keys(result).length ? result : undefined
}

export function captureCompatibleToolSignature(
  metadata: SharedV3ProviderMetadata,
  model: Provider.Model,
  languageProvider: string,
) {
  if (model.api.npm !== "@ai-sdk/openai-compatible") return metadata
  return moveSignature(metadata, sdkKeys(languageProvider), stored)
}

export function compatibleToolCallMetadata(
  metadata: SharedV3ProviderMetadata | undefined,
  model: Provider.Model,
  languageProvider?: string,
) {
  if (!metadata) return metadata
  if (model.api.npm !== "@ai-sdk/openai-compatible") return moveSignature(metadata, [stored])
  // Older calls retain the incoming namespace. Always consume the reserved
  // passthrough alias too: otherwise the SDK spreads thoughtSignature onto
  // both the call and its result if options.name changed since capture.
  return moveSignature(
    metadata,
    [stored, ...sdkKeys(languageProvider ?? model.providerID), "openaiCompatible"],
    "google",
  )
}
