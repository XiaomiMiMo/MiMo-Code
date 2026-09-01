import { describe, expect, test } from "bun:test"
import { ConfigMCP } from "../../src/config/mcp"

describe("ConfigMCP.normalizeMcp", () => {
  test("converts Claude command + args + env into a local server", () => {
    const { data, warnings } = ConfigMCP.normalizeMcp({
      mcpServers: {
        firecrawl: {
          command: "npx",
          args: ["-y", "firecrawl-mcp"],
          env: { FIRECRAWL_API_KEY: "key" },
        },
      },
    })
    expect(warnings).toEqual([])
    expect(data).toEqual({
      mcp: {
        firecrawl: {
          type: "local",
          command: ["npx", "-y", "firecrawl-mcp"],
          environment: { FIRECRAWL_API_KEY: "key" },
          enabled: true,
        },
      },
    })
  })

  test("accepts the environment spelling too", () => {
    const { data } = ConfigMCP.normalizeMcp({
      mcpServers: { s: { command: "echo", environment: { A: "1" } } },
    })
    expect(data).toEqual({
      mcp: {
        s: { type: "local", command: ["echo"], environment: { A: "1" }, enabled: true },
      },
    })
  })

  test("converts a url server into a remote server", () => {
    const { data, warnings } = ConfigMCP.normalizeMcp({
      mcpServers: {
        remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
      },
    })
    expect(warnings).toEqual([])
    expect(data).toEqual({
      mcp: {
        remote: {
          type: "remote",
          url: "https://example.com/mcp",
          enabled: true,
          headers: { Authorization: "Bearer x" },
        },
      },
    })
  })

  test("passes sampling through for claude-format entries", () => {
    const { data, warnings } = ConfigMCP.normalizeMcp({
      mcpServers: { s: { command: "echo", sampling: "allow" } },
    })
    expect(warnings).toEqual([])
    expect(data).toEqual({
      mcp: { s: { type: "local", command: ["echo"], enabled: true, sampling: "allow" } },
    })
  })

  test("skips an entry with an invalid sampling value", () => {
    const { data, warnings } = ConfigMCP.normalizeMcp({
      mcpServers: {
        bad: { command: "echo", sampling: "bogus" },
        good: { command: "true" },
      },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("sampling")
    expect(data).toEqual({ mcp: { good: { type: "local", command: ["true"], enabled: true } } })
  })

  test("skips sse servers with a warning, keeps the rest", () => {
    const { data, warnings } = ConfigMCP.normalizeMcp({
      mcpServers: {
        bad: { type: "sse", url: "https://example.com/sse" },
        good: { command: "echo", args: ["hi"] },
      },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("unsupported transport")
    expect(data).toEqual({
      mcp: {
        good: { type: "local", command: ["echo", "hi"], enabled: true },
      },
    })
  })

  test("keeps native mcp-format entries inside mcpServers (mixed formats)", () => {
    const { data, warnings } = ConfigMCP.normalizeMcp({
      mcpServers: {
        codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"] },
        firecrawl: { command: "npx", args: ["-y", "firecrawl-mcp"], env: { K: "v" } },
      },
    })
    expect(warnings).toEqual([])
    expect(data).toEqual({
      mcp: {
        codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"] },
        firecrawl: {
          type: "local",
          command: ["npx", "-y", "firecrawl-mcp"],
          environment: { K: "v" },
          enabled: true,
        },
      },
    })
  })

  test("keeps native entries and converts claude entries inside mcp (mixed formats)", () => {
    const { data, warnings } = ConfigMCP.normalizeMcp({
      mcp: {
        codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"] },
        "firecrawl-mcp": {
          command: "npx",
          args: ["-y", "firecrawl-mcp"],
          env: { FIRECRAWL_API_KEY: "key" },
        },
      },
    })
    expect(warnings).toEqual([])
    expect(data).toEqual({
      mcp: {
        codegraph: { type: "local", command: ["codegraph", "serve", "--mcp"] },
        "firecrawl-mcp": {
          type: "local",
          command: ["npx", "-y", "firecrawl-mcp"],
          environment: { FIRECRAWL_API_KEY: "key" },
          enabled: true,
        },
      },
    })
  })

  test("keeps the legacy enabled-only disable form under either key", () => {
    const fromMcp = ConfigMCP.normalizeMcp({ mcp: { off: { enabled: false } } })
    expect(fromMcp.warnings).toEqual([])
    expect(fromMcp.data).toEqual({ mcp: { off: { enabled: false } } })

    const fromMcpServers = ConfigMCP.normalizeMcp({ mcpServers: { off: { enabled: false } } })
    expect(fromMcpServers.warnings).toEqual([])
    expect(fromMcpServers.data).toEqual({ mcp: { off: { enabled: false } } })
  })

  test("prefers mcp when both keys are present (loadConfig rejects first)", () => {
    const { data, warnings } = ConfigMCP.normalizeMcp({
      mcp: { a: { type: "local", command: ["legacy"] } },
      mcpServers: { b: { command: "claude" } },
    })
    expect(warnings).toEqual([])
    expect(data).toEqual({ mcp: { a: { type: "local", command: ["legacy"] } } })
  })

  test("non-object mcpServers is dropped with a warning", () => {
    const { data, warnings } = ConfigMCP.normalizeMcp({
      model: "test/model",
      mcpServers: "oops",
    })
    expect(warnings).toHaveLength(1)
    expect(data).toEqual({ model: "test/model" })
  })

  test("returns config unchanged when neither mcp nor mcpServers is present", () => {
    const input = { model: "test/model" }
    const { data, warnings } = ConfigMCP.normalizeMcp(input)
    expect(warnings).toEqual([])
    expect(data).toEqual(input)
  })

  test("passes a native-only mcp block through unchanged", () => {
    const input = { mcp: { s: { type: "local", command: ["x"] } } }
    const { data, warnings } = ConfigMCP.normalizeMcp(input)
    expect(warnings).toEqual([])
    expect(data).toEqual(input)
  })
})
