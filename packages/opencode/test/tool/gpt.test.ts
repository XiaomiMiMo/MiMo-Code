import { describe, expect, test } from "bun:test"
import { isGPTModel, isMcpToolSearchEnabled, usesCodexMode } from "../../src/tool/gpt"

describe("isGPTModel", () => {
  test("recognizes GPT versions and API aliases", () => {
    expect(isGPTModel("gpt-4o")).toBe(true)
    expect(isGPTModel("chatgpt-4o-latest")).toBe(true)
    expect(isGPTModel("gpt-5.3-codex")).toBe(true)
    expect(isGPTModel("company-alias", "gpt-5.4", "gpt-5")).toBe(true)
  })

  test("excludes non-GPT and GPT-OSS models", () => {
    expect(isGPTModel("claude-opus-4-6")).toBe(false)
    expect(isGPTModel("gpt-oss-120b")).toBe(false)
    expect(isGPTModel("company-gpt-production", "gpt-oss-120b", "gpt-oss")).toBe(false)
  })
})

describe("isMcpToolSearchEnabled", () => {
  test("uses GPT models as the fallback when the global route is disabled", () => {
    expect(isMcpToolSearchEnabled(false, "claude-opus-4-6")).toBe(false)
    expect(isMcpToolSearchEnabled(false, "gpt-5.2")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "gpt-oss-120b")).toBe(false)
    expect(isMcpToolSearchEnabled(true, "claude-opus-4-6")).toBe(true)
  })
})

describe("usesCodexMode", () => {
  test("applies Codex mode to every model when enabled", () => {
    expect(usesCodexMode(true, "claude-opus-4-6")).toBe(true)
    expect(usesCodexMode(true, "mimo-v2.5-pro")).toBe(true)
    expect(usesCodexMode(true, "gpt-oss-120b")).toBe(true)
  })

  test("falls back to the legacy GPT-5+ route when disabled", () => {
    expect(usesCodexMode(false, "gpt-5.4")).toBe(true)
    expect(usesCodexMode(false, "gpt-4o")).toBe(false)
    expect(usesCodexMode(false, "gpt-oss-120b")).toBe(false)
    expect(usesCodexMode(false, "claude-opus-4-6")).toBe(false)
  })
})
