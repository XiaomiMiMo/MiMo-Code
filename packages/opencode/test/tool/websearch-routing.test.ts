import { describe, expect, test } from "bun:test"
import { usesMimoWebsearch } from "../../src/tool/websearch"

describe("websearch provider routing", () => {
  test("uses the MiMo backend for Xiaomi provider variants", () => {
    expect(usesMimoWebsearch("xiaomi")).toBe(true)
    expect(usesMimoWebsearch("xiaomi-token-plan-cn")).toBe(true)
    expect(usesMimoWebsearch("openai")).toBe(false)
  })
})
