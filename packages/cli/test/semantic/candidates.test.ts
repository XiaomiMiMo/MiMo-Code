import { afterEach, describe, expect, test } from "bun:test"
import { enabled, search } from "../../src/semantic/candidates"

const keys = [
  "MIMOCODE_SEMANTIC_ENABLED",
  "MIMOCODE_SEMANTIC_MEMORY",
  "MIMOCODE_SEMANTIC_HISTORY",
  "MIMOCODE_SEMANTIC_FAILURE",
  "MIMOCODE_SEMANTIC_REBUILD",
  "MIMOCODE_SEMANTIC_INJECT",
  "MIMOCODE_SEMINDEX_HELPER",
] as const
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of keys) {
    const value = original[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})

describe("semantic candidates", () => {
  test("features require the global gate and their independent gate", () => {
    process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
    process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
    expect(enabled("memory")).toBe(true)
    expect(enabled("history")).toBe(false)
    process.env.MIMOCODE_SEMANTIC_ENABLED = "1"
    expect(enabled("memory")).toBe(false)
  })

  test("missing local helper and empty allow set fail closed", async () => {
    delete process.env.MIMOCODE_SEMINDEX_HELPER
    expect(await search({ corpus: "memory", query: "synthetic query", allowed: ["/tmp/example"], limit: 3 })).toEqual({ status: "unavailable" })
    process.env.MIMOCODE_SEMINDEX_HELPER = "/tmp/example-helper.py"
    expect(await search({ corpus: "memory", query: "synthetic query", allowed: [], limit: 3 })).toEqual({ status: "unavailable" })
  })
})
