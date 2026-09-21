import { describe, expect, test } from "bun:test"
import { maxOutputTokens } from "../../src/provider/transform"

// Structural stand-in: maxOutputTokens/usesLargeModelDefaults read only
// id/providerID/api.id/limit.output.
type BudgetModel = {
  id: string
  providerID: string
  api: { id: string }
  limit: { context: number; output: number }
}

function model(overrides: Partial<BudgetModel> = {}): BudgetModel {
  return {
    id: "ox-alpha-free",
    providerID: "go-orb",
    api: { id: "ox-alpha-free" },
    limit: { context: 1_000_000, output: 131_072 },
    ...overrides,
  }
}

describe("maxOutputTokens", () => {
  test("mimo-family keeps the wide budget", () => {
    expect(maxOutputTokens(model({ id: "mimo-v2.5", providerID: "xiaomi" }) as never)).toBe(128_000)
  })

  test("default effort stays at the flat cap", () => {
    const m = model()
    expect(maxOutputTokens(m as never)).toBe(Math.min(m.limit.output, 32_000))
    expect(maxOutputTokens(m as never, { reasoningEffort: "low" })).toBe(Math.min(m.limit.output, 32_000))
    expect(maxOutputTokens(m as never, { reasoningEffort: "medium" })).toBe(Math.min(m.limit.output, 32_000))
  })

  test("deep reasoning efforts raise the ceiling to the wide budget", () => {
    for (const effort of ["high", "xhigh", "max"]) {
      expect(maxOutputTokens(model() as never, { reasoningEffort: effort })).toBe(
        Math.min(model().limit.output, 128_000),
      )
    }
  })

  test("model output limit still bounds deep-effort budgets", () => {
    const small = model({ limit: { context: 100_000, output: 16_384 } })
    expect(maxOutputTokens(small as never, { reasoningEffort: "max" })).toBe(16_384)
  })
})
