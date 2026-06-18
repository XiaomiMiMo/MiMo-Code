export function customProviderEnvKey(providerID: string) {
  return `${providerID.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`
}

export function optionalApiKey(input: string) {
  const key = input.trim()
  return key.length > 0 ? key : undefined
}

export function customProviderConfig(input: {
  providerID: string
  name: string
  baseURL: string
  modelID: string
  modelName: string
}) {
  return {
    provider: {
      [input.providerID]: {
        name: input.name,
        npm: "@ai-sdk/openai-compatible",
        env: [customProviderEnvKey(input.providerID)],
        options: {
          baseURL: input.baseURL,
          setCacheKey: true,
        },
        models: {
          [input.modelID]: {
            name: input.modelName,
          },
        },
      },
    },
  } as const
}
