import { describe, expect, test } from "bun:test"
import { getProviderDefaultModel } from "./model-default"

const providers: Parameters<typeof getProviderDefaultModel>[0] = [
  {
    id: "openai",
    models: {
      "gpt-5": { id: "gpt-5" },
      "gpt-4.1": { id: "gpt-4.1" },
    },
  },
  {
    id: "deepseek",
    models: {
      "deepseek-v4-pro": { id: "deepseek-v4-pro" },
    },
  },
]

describe("getProviderDefaultModel", () => {
  test("uses the provider default model when it is available", () => {
    expect(getProviderDefaultModel(providers, { openai: "gpt-5" }, "openai")).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
  })

  test("falls back to the first provider model when the default is missing", () => {
    expect(getProviderDefaultModel(providers, { openai: "missing" }, "openai")).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
  })

  test("returns undefined for unknown providers", () => {
    expect(getProviderDefaultModel(providers, {}, "anthropic")).toBeUndefined()
  })
})
