import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "fs/promises"
import { join } from "path"
import { isPluginInstalled, parseMarketplaceJson, parsePluginSource } from "../../../../src/cli/cmd/tui/feature-plugins/system/marketplace"

describe("parseMarketplaceJson", () => {
  test("maps entries to name + description", () => {
    const raw = JSON.stringify({
      name: "claude-plugins-official",
      plugins: [
        { name: "frontend-design", description: "Build distinctive UI" },
        { name: "pdf", description: "Generate PDF documents" },
      ],
    })
    expect(parseMarketplaceJson(raw)).toEqual([
      { name: "frontend-design", description: "Build distinctive UI", source: undefined },
      { name: "pdf", description: "Generate PDF documents", source: undefined },
    ])
  })

  test("defaults missing description to empty string", () => {
    const raw = JSON.stringify({ plugins: [{ name: "no-desc" }] })
    expect(parseMarketplaceJson(raw)).toEqual([{ name: "no-desc", description: "", source: undefined }])
  })

  test("filters out entries without a name", () => {
    const raw = JSON.stringify({
      plugins: [
        { description: "has no name field" },
        { name: "valid", description: "ok" },
      ],
    })
    expect(parseMarketplaceJson(raw)).toEqual([{ name: "valid", description: "ok", source: undefined }])
  })

  test("returns empty array when plugins array is empty", () => {
    const raw = JSON.stringify({ plugins: [] })
    expect(parseMarketplaceJson(raw)).toEqual([])
  })

  test("throws on invalid JSON", () => {
    expect(() => parseMarketplaceJson("not json")).toThrow()
  })

  test("filters out null entries without throwing", () => {
    const raw = JSON.stringify({ plugins: [{ name: "valid", description: "ok" }, null] })
    expect(parseMarketplaceJson(raw)).toEqual([{ name: "valid", description: "ok", source: undefined }])
  })

  test("treats non-array plugins as empty", () => {
    const raw = JSON.stringify({ plugins: "not-an-array" })
    expect(parseMarketplaceJson(raw)).toEqual([])
  })

  test("defaults non-string description to empty", () => {
    const raw = JSON.stringify({ plugins: [{ name: "x", description: 42 }] })
    expect(parseMarketplaceJson(raw)).toEqual([{ name: "x", description: "", source: undefined }])
  })
})

describe("parsePluginSource", () => {
  test("parses relative path string", () => {
    expect(parsePluginSource("./plugins/frontend-design")).toEqual({
      kind: "relative",
      path: "./plugins/frontend-design",
    })
  })

  test("parses url source object", () => {
    const raw = { source: "url", url: "https://github.com/x/y.git", sha: "abc123" }
    expect(parsePluginSource(raw)).toEqual({
      kind: "url",
      url: "https://github.com/x/y.git",
      sha: "abc123",
    })
  })

  test("parses git-subdir source object", () => {
    const raw = {
      source: "git-subdir",
      url: "https://github.com/x/skills.git",
      path: "plugins/airtable",
      ref: "main",
      sha: "295ab93b",
    }
    expect(parsePluginSource(raw)).toEqual({
      kind: "git-subdir",
      url: "https://github.com/x/skills.git",
      path: "plugins/airtable",
      sha: "295ab93b",
    })
  })

  test("parses github source object", () => {
    const raw = { source: "github", repo: "fullstorydev/fullstory-skills", commit: "1ec5865e" }
    expect(parsePluginSource(raw)).toEqual({
      kind: "github",
      repo: "fullstorydev/fullstory-skills",
    })
  })

  test("returns undefined for non-relative string without ./", () => {
    expect(parsePluginSource("https://example.com/foo")).toBeUndefined()
    expect(parsePluginSource("plain-name")).toBeUndefined()
  })

  test("returns undefined for unknown source discriminator", () => {
    expect(parsePluginSource({ source: "unknown", url: "x" })).toBeUndefined()
  })

  test("returns undefined for undefined/null/non-record", () => {
    expect(parsePluginSource(undefined)).toBeUndefined()
    expect(parsePluginSource(null)).toBeUndefined()
    expect(parsePluginSource("")).toBeUndefined()
    expect(parsePluginSource(42)).toBeUndefined()
    expect(parsePluginSource([])).toBeUndefined()
  })
})

describe("isPluginInstalled", () => {
  // 用真实临时目录测，避免 mock，覆盖 GitHub 插件整包全是 dotfile 的真实场景。
  const tmp = join(import.meta.dir, ".tmp-isinstalled")
  const dir = join(tmp, "plugin")

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  test("returns false when dir does not exist", async () => {
    expect(await isPluginInstalled(join(tmp, "nope"))).toBe(false)
  })

  test("returns false when dir exists but is empty", async () => {
    await mkdir(dir, { recursive: true })
    expect(await isPluginInstalled(dir)).toBe(false)
  })

  // 核心回归：GitHub 官方 MCP 插件整包全是点文件（.claude-plugin/plugin.json、
  // .mcp.json），不含任何普通文件。glob 默认忽略 dotfile 会判 0 文件→未装，
  // 与下载器 readdir 判定冲突，导致“提示已安装但分组看不到”。
  test("returns true when dir contains only dotfiles", async () => {
    await mkdir(join(dir, ".claude-plugin"), { recursive: true })
    await writeFile(join(dir, ".claude-plugin", "plugin.json"), "{}")
    await writeFile(join(dir, ".mcp.json"), "{}")
    expect(await isPluginInstalled(dir)).toBe(true)
  })

  test("returns true when dir contains a regular file", async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "SKILL.md"), "# skill")
    expect(await isPluginInstalled(dir)).toBe(true)
  })
})
