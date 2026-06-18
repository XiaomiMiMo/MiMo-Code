export function getProviderDefaultModel(
  providers: { id: string; models: Record<string, { id: string }> }[],
  defaults: Record<string, string>,
  providerID: string,
) {
  const provider = providers.find((x) => x.id === providerID)
  if (!provider) return

  const configured = defaults[provider.id]
  if (configured && provider.models[configured]) return { providerID: provider.id, modelID: configured }

  const first = Object.values(provider.models)[0]
  if (!first) return
  return { providerID: provider.id, modelID: first.id }
}
