import { ModelID, ProviderID } from "../provider/schema"

/**
 * Pure resolution logic for choosing the default model.
 * Separated for testability — no SDK calls, no side effects.
 */
export function resolveDefaultModel(
  specified: { providerID: ProviderID; modelID: ModelID } | undefined,
  providers: Array<{ id: string; models: Record<string, unknown> }>,
): { providerID: ProviderID; modelID: ModelID } | undefined {
  if (specified && providers.length) {
    const provider = providers.find((p) => p.id === specified.providerID)
    if (provider && provider.models[specified.modelID]) return specified
    // Provider not yet loaded or model not found — still honor the user's explicit choice
    // rather than falling through to Provider.sort() which may pick a paid model
    if (!provider || !provider.models[specified.modelID]) return specified
  }

  if (specified && !providers.length) return specified

  return undefined // let caller handle fallback
}
