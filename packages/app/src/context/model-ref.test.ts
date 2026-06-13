import { describe, expect, test } from "bun:test"
import { parseModelRef } from "./model-ref"

describe("parseModelRef", () => {
  test("keeps slashes inside model ids", () => {
    expect(parseModelRef("nvidia/nvidia/nemotron-3-super-120b-a12b")).toEqual({
      providerID: "nvidia",
      modelID: "nvidia/nemotron-3-super-120b-a12b",
    })
  })

  test("rejects missing provider or model", () => {
    expect(parseModelRef(undefined)).toBeUndefined()
    expect(parseModelRef("nvidia")).toBeUndefined()
    expect(parseModelRef("/model")).toBeUndefined()
    expect(parseModelRef("provider/")).toBeUndefined()
  })
})
