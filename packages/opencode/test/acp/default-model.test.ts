import { test, expect, describe } from "bun:test"
import { resolveDefaultModel } from "../../src/acp/resolve-model"
import { ProviderID, ModelID } from "../../src/provider/schema"

describe("resolveDefaultModel", () => {
  const mimo = {
    providerID: ProviderID.make("mimo"),
    modelID: ModelID.make("mimo-auto"),
  }

  test("returns specified when provider is not in providers list", () => {
    const result = resolveDefaultModel(mimo, [
      { id: "xiaomi", models: { "some-model": {} } },
    ])
    expect(result).toEqual(mimo)
  })

  test("returns specified when provider exists but model not indexed", () => {
    const result = resolveDefaultModel(mimo, [
      { id: "mimo", models: {} },
    ])
    expect(result).toEqual(mimo)
  })

  test("returns specified when providers list is empty", () => {
    const result = resolveDefaultModel(mimo, [])
    expect(result).toEqual(mimo)
  })

  test("returns specified when provider and model both present", () => {
    const result = resolveDefaultModel(mimo, [
      { id: "mimo", models: { "mimo-auto": { id: "mimo-auto" } } },
    ])
    expect(result).toEqual(mimo)
  })

  test("returns undefined when no specified model", () => {
    const result = resolveDefaultModel(undefined, [
      { id: "mimo", models: { "mimo-auto": {} } },
    ])
    expect(result).toBeUndefined()
  })

  test("returns undefined when no specified and no providers", () => {
    const result = resolveDefaultModel(undefined, [])
    expect(result).toBeUndefined()
  })
})
