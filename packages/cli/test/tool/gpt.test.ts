import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mcpToolSearchMode, usesCodexMode } from "../../src/tool/gpt"

const codexMode = process.env.MIMOCODE_CODEX_MODE

beforeEach(() => {
  delete process.env.MIMOCODE_CODEX_MODE
})

afterEach(() => {
  if (codexMode === undefined) delete process.env.MIMOCODE_CODEX_MODE
  else process.env.MIMOCODE_CODEX_MODE = codexMode
})

describe("usesCodexMode", () => {
  test("defaults to the default harness when neither flag nor harness selects Codex", () => {
    expect(usesCodexMode()).toBe(false)
    expect(usesCodexMode("auto")).toBe(false)
    expect(usesCodexMode("default")).toBe(false)
  })

  test("an explicit codex harness opts in", () => {
    expect(usesCodexMode("codex")).toBe(true)
  })

  test("MIMOCODE_CODEX_MODE=true enables Codex for auto but not for an explicit default harness", () => {
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(usesCodexMode()).toBe(true)
    expect(usesCodexMode("auto")).toBe(true)
    expect(usesCodexMode("codex")).toBe(true)
    expect(usesCodexMode("default")).toBe(false)
  })

  test("MIMOCODE_CODEX_MODE=false wins over an explicit codex harness", () => {
    process.env.MIMOCODE_CODEX_MODE = "false"
    expect(usesCodexMode("codex")).toBe(false)
    expect(usesCodexMode("auto")).toBe(false)
  })
})

describe("mcpToolSearchMode", () => {
  const auto = { type: "auto", percent: 10 } as const
  const never = { type: "never" } as const
  const always = { type: "always" } as const

  test("keeps the configured mode outside Codex mode", () => {
    expect(mcpToolSearchMode(auto, undefined)).toEqual(auto)
    expect(mcpToolSearchMode(never, "auto")).toEqual(never)
    expect(mcpToolSearchMode(always, "default")).toEqual(always)
  })

  test("always defers in Codex mode", () => {
    expect(mcpToolSearchMode(never, "codex")).toEqual(always)
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(mcpToolSearchMode(auto, "auto")).toEqual(always)
    expect(mcpToolSearchMode(auto, "default")).toEqual(auto)
  })
})
