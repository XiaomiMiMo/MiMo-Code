import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible"
import { Instance } from "../../src/project/instance"
import type { SDKBinding } from "../../src/provider/sdk-binding"

const configurations = new WeakMap<SDKBinding, OpenAICompatibleProviderSettings>()

function languageModel(this: SDKBinding, modelID: string) {
  const options = configurations.get(this)
  if (!options) throw new Error("fixture SDK configuration missing")
  return createOpenAICompatible(options).languageModel(modelID)
}

// Identical options do not make a context-capturing third-party factory shareable.
export function createContextProvider(options: OpenAICompatibleProviderSettings & { fixturePlainSDK?: boolean }) {
  if (options.fixturePlainSDK) {
    // Structurally identical SDK objects can have distinct hidden configuration.
    const sdk = { languageModel }
    configurations.set(sdk, options)
    return sdk
  }
  const directory = Instance.current.directory
  return createOpenAICompatible({ ...options, headers: { ...options.headers, "x-tenant": directory } })
}

// Auth loaders remain scoped until their Plugin Host has an explicit identity.
export default {
  id: "test.binding-auth",
  server: async () => ({
    auth: {
      provider: "binding-test",
      loader: async () => ({ apiKey: "test-key" }),
      methods: [],
    },
  }),
}
