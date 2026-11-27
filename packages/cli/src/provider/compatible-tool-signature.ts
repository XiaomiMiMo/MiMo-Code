import type { SharedV3ProviderMetadata } from "@ai-sdk/provider"
import type * as Provider from "./provider"

// The compatible SDK returns tool signatures under its configured name (or its
// camel-case options alias), but reads them only from `google` on the way out.
export function compatibleToolCallMetadata(
  metadata: SharedV3ProviderMetadata | undefined,
  model: Provider.Model,
  languageProvider?: string,
): SharedV3ProviderMetadata | undefined {
  if (model.api.npm !== "@ai-sdk/openai-compatible" || !metadata) return metadata
  const name = (languageProvider ?? model.providerID).split(".")[0].trim()
  const camel = name.replace(/[_-]([a-z])/g, (_, letter: string) => letter.toUpperCase())
  const key = [name, camel].find((key) => Object.hasOwn(metadata[key] ?? {}, "thoughtSignature"))
  if (key == null) return metadata

  const { thoughtSignature, ...siblings } = metadata[key]
  const options = { ...metadata }
  // Move only the signature. In particular, the SDK spreads `openaiCompatible`
  // onto the wire, so leaving the camel-case field there would leak it twice.
  if (Object.keys(siblings).length === 0) delete options[key]
  else options[key] = siblings
  if (typeof thoughtSignature === "string" && thoughtSignature !== "") {
    options.google = { ...options.google, thoughtSignature }
  }
  return Object.keys(options).length ? options : undefined
}
