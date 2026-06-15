import type { Hooks, PluginInput } from "@mimo-ai/plugin"

const GLOBAL_MODELS = {
  "gpt-4o-mini": {
    name: "GPT-4o Mini",
    attachment: true,
    reasoning: false,
    tool_call: true,
    temperature: true,
    limit: { context: 128_000, output: 16_384 },
  },
  "gpt-4.1-mini": {
    name: "GPT-4.1 Mini",
    attachment: true,
    reasoning: false,
    tool_call: true,
    temperature: true,
    limit: { context: 1_000_000, output: 32_768 },
  },
  "gpt-4.1-nano": {
    name: "GPT-4.1 Nano",
    attachment: true,
    reasoning: false,
    tool_call: true,
    temperature: true,
    limit: { context: 1_000_000, output: 32_768 },
  },
  "o3-2025-04-16": {
    name: "o3",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: false,
    limit: { context: 200_000, output: 100_000 },
  },
  "text-embedding-3-large": {
    name: "Text Embedding 3 Large",
    attachment: false,
    reasoning: false,
    tool_call: false,
    temperature: false,
    limit: { context: 8_191, output: 1 },
  },
}

export async function AstraflowAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    config: async (input) => {
      input.provider ??= {}
      input.provider.astraflow ??= {
        name: "Astraflow",
        env: ["ASTRAFLOW_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://api-us-ca.umodelverse.ai/v1",
        models: GLOBAL_MODELS,
      }
      input.provider["astraflow-cn"] ??= {
        name: "Astraflow China",
        env: ["ASTRAFLOW_CN_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.modelverse.cn/v1",
        models: GLOBAL_MODELS,
      }
    },
  }
}
