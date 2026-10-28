import { describe, expect, test } from "bun:test"
import type { Provider } from "@mimo-ai/sdk/v2"
import { fallback, familyDefaultModel, initial } from "../../../src/cli/cmd/tui/util/model"

const providers = [
  {
    id: "openai",
    models: {
      "gpt-5.6-sol": {},
    },
  },
  {
    id: "ppio",
    models: {
      "deepseek-v3": {},
    },
  },
] as unknown as Provider[]

const withXiaomiPro = [
  {
    id: "openai",
    models: { "gpt-5.6-sol": {} },
  },
  {
    id: "xiaomi",
    models: {
      "mimo-v2.6-pro": {},
      "mimo-v2.6": {},
    },
  },
] as unknown as Provider[]

describe("initial model", () => {
  test("restores the most recent model before the configured default", () => {
    expect(
      initial(providers, {
        ready: true,
        recent: [{ providerID: "openai", modelID: "gpt-5.6-sol" }],
        configured: "ppio/deepseek-v3",
      }),
    ).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
  })

  test("keeps an explicit model argument highest priority", () => {
    expect(
      initial(providers, {
        argument: "ppio/deepseek-v3",
        ready: false,
        recent: [{ providerID: "openai", modelID: "gpt-5.6-sol" }],
        configured: "openai/gpt-5.6-sol",
      }),
    ).toEqual({ providerID: "ppio", modelID: "deepseek-v3" })
  })

  test("skips unavailable recent models", () => {
    expect(
      initial(providers, {
        ready: true,
        recent: [{ providerID: "openai", modelID: "removed-model" }],
        configured: "ppio/deepseek-v3",
      }),
    ).toEqual({ providerID: "ppio", modelID: "deepseek-v3" })
  })

  test("waits for recent state before using the configured default", () => {
    expect(
      initial(providers, {
        ready: false,
        recent: [],
        configured: "ppio/deepseek-v3",
      }),
    ).toBeUndefined()
  })
})

describe("fallback model", () => {
  test("prefers xiaomi/mimo-v2.6-pro when no recent/configured match", () => {
    expect(fallback(withXiaomiPro, { openai: "gpt-5.6-sol" })).toEqual({
      providerID: "xiaomi",
      modelID: "mimo-v2.6-pro",
    })
  })

  test("switches to the keyed family member over the keyless xiaomi default", () => {
    const list = [
      { id: "xiaomi", models: { "mimo-v2.6-pro": {} } },
      { id: "xiaomi-token-plan-cn", key: "sk-cn", models: { "mimo-v2.6-pro": {} } },
    ] as unknown as Provider[]
    expect(fallback(list, {})).toEqual({ providerID: "xiaomi-token-plan-cn", modelID: "mimo-v2.6-pro" })
  })

  test("walks keyed family members in fallback order (token-plan before API)", () => {
    const list = [
      { id: "xiaomi", key: "sk-api", models: { "mimo-v2.6-pro": {} } },
      { id: "xiaomi-token-plan-sgp", key: "sk-sgp", models: { "mimo-v2.6-pro": {} } },
    ] as unknown as Provider[]
    expect(fallback(list, {})).toEqual({ providerID: "xiaomi-token-plan-sgp", modelID: "mimo-v2.6-pro" })
  })

  test("falls back to the first provider default when xiaomi pro is absent", () => {
    expect(fallback(providers, { openai: "gpt-5.6-sol" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    })
  })

  test("falls back to the first model when no provider default is set", () => {
    expect(fallback(providers, {})).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    })
  })

  test("returns undefined with no providers", () => {
    expect(fallback(undefined)).toBeUndefined()
    expect(fallback([])).toBeUndefined()
  })
})

describe("familyDefaultModel", () => {
  test("prefers the pro model of the first signed-in family member", () => {
    const list = [
      { id: "xiaomi-token-plan-cn", key: "sk-cn", models: { "mimo-v2.5": {}, "mimo-v2.6-pro": {} } },
      { id: "xiaomi", key: "sk-api", models: { "mimo-v2.6-pro": {} } },
    ] as unknown as Provider[]
    expect(familyDefaultModel(list)).toEqual({ providerID: "xiaomi-token-plan-cn", modelID: "mimo-v2.6-pro" })
  })

  test("treats options.apiKey as a credential", () => {
    const list = [
      { id: "xiaomi-token-plan-ams", options: { apiKey: "sk-ams" }, models: { "mimo-v2.6-pro": {} } },
    ] as unknown as Provider[]
    expect(familyDefaultModel(list)).toEqual({ providerID: "xiaomi-token-plan-ams", modelID: "mimo-v2.6-pro" })
  })

  test("returns undefined when no family member holds credentials and models", () => {
    const keyedWithoutModels = [{ id: "xiaomi-token-plan-cn", key: "sk-cn", models: {} }] as unknown as Provider[]
    expect(familyDefaultModel(keyedWithoutModels)).toBeUndefined()
    expect(familyDefaultModel(withXiaomiPro)).toBeUndefined()
    expect(familyDefaultModel(undefined)).toBeUndefined()
  })
})
