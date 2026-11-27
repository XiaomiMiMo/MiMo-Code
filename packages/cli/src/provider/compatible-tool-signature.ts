import type { SharedV3ProviderMetadata } from "@ai-sdk/provider"
import type * as Provider from "./provider"

// The compatible SDK reads tool-call signatures from `google` on replay but
// emits them under its configured provider name (or the camel-case alias).
export function captureCompatibleToolSignature(
  metadata: SharedV3ProviderMetadata,
  model: Provider.Model,
  languageProvider: string,
) {
  if (model.api.npm !== "@ai-sdk/openai-compatible") return metadata
  const name = languageProvider.split(".")[0].trim()
  const key = [name, name.replace(/[_-]([a-z])/g, (_, letter: string) => letter.toUpperCase())]
    .find((key) => typeof metadata[key]?.thoughtSignature === "string" && metadata[key].thoughtSignature)
  if (key == null || key === "google") return metadata
  const { thoughtSignature, ...rest } = metadata[key]
  const normalized: SharedV3ProviderMetadata = { ...metadata, google: { ...metadata.google, thoughtSignature } }
  if (Object.keys(rest).length) normalized[key] = rest
  else delete normalized[key]
  return normalized
}
