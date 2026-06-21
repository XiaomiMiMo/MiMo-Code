import { ModelID, ProviderID } from "../provider/schema"

/**
 * Pure resolution logic for choosing the default model.
 * Separated for testability — no SDK calls, no side effects.
 *
 * If the user specified a model in config.json, always honor it —
 * regardless of whether the provider/model is currently loaded.
 * This prevents falling through to Provider.sort() which may pick a paid model.
 */
export function resolveDefaultModel(
  specified: { providerID: ProviderID; modelID: ModelID } | undefined,
  providers: Array<{ id: string; models: Record<string, unknown> }>,
): { providerID: ProviderID; modelID: ModelID } | undefined {
  if (specified) return specified
  return undefined
}
