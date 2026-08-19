import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isGPTModel, isMcpToolSearchEnabled, usesGPTToolset } from "../../src/tool/gpt"

const codexMode = process.env.MIMOCODE_CODEX_MODE

beforeEach(() => {
  delete process.env.MIMOCODE_CODEX_MODE
})

afterEach(() => {
  if (codexMode === undefined) delete process.env.MIMOCODE_CODEX_MODE
  else process.env.MIMOCODE_CODEX_MODE = codexMode
})

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
  test("defaults to GPT models and allows explicit non-GPT opt-in", () => {
    expect(isMcpToolSearchEnabled(false, "claude-opus-4-6")).toBe(false)
    expect(isMcpToolSearchEnabled(false, "gpt-5.2")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "gpt-oss-120b")).toBe(false)
    expect(isMcpToolSearchEnabled(true, "claude-opus-4-6")).toBe(true)
  })

  test("is enabled for non-GPT models in Codex mode", () => {
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(isMcpToolSearchEnabled(false, "claude-opus-4-6")).toBe(true)
  })
})

describe("usesGPTToolset", () => {
  test("uses the GPT toolset for every model in Codex mode", () => {
    expect(usesGPTToolset("claude-opus-4-6")).toBe(false)
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(usesGPTToolset("claude-opus-4-6")).toBe(true)
  })
})
