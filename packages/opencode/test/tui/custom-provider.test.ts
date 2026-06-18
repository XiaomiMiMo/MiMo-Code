import { describe, expect, test } from "bun:test"
import { customProviderConfig, customProviderEnvKey, optionalApiKey } from "../../src/cli/cmd/tui/util/custom-provider"

describe("custom provider wizard helpers", () => {
  test("treats blank API key as optional", () => {
    expect(optionalApiKey("")).toBeUndefined()
    expect(optionalApiKey("   ")).toBeUndefined()
    expect(optionalApiKey("sk-test")).toBe("sk-test")
    expect(optionalApiKey("  sk-test  ")).toBe("sk-test")
  })

  test("builds openai-compatible provider config without embedding auth", () => {
    expect(customProviderEnvKey("local-llm")).toBe("LOCAL_LLM_API_KEY")
    expect(
      customProviderConfig({
        providerID: "local-llm",
        name: "Local LLM",
        baseURL: "http://localhost:11434/v1",
        modelID: "llama-3",
        modelName: "Llama 3",
      }),
    ).toEqual({
      provider: {
        "local-llm": {
          name: "Local LLM",
          npm: "@ai-sdk/openai-compatible",
          env: ["LOCAL_LLM_API_KEY"],
          options: {
            baseURL: "http://localhost:11434/v1",
            setCacheKey: true,
          },
          models: {
            "llama-3": {
              name: "Llama 3",
            },
          },
        },
      },
    })
  })
})
