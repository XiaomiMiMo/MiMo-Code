import { describe, expect, test } from "bun:test"
import { ConfigMCP } from "../../src/config/mcp"

describe("ConfigMCP.normalizeMcpServers", () => {
  test("converts Claude command + args + env into a local server", () => {
    const { data, warnings } = ConfigMCP.normalizeMcpServers({
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
    const { data } = ConfigMCP.normalizeMcpServers({
      mcpServers: { s: { command: "echo", environment: { A: "1" } } },
    })
    expect(data).toEqual({
      mcp: {
        s: { type: "local", command: ["echo"], environment: { A: "1" }, enabled: true },
      },
    })
  })

  test("converts a url server into a remote server", () => {
    const { data, warnings } = ConfigMCP.normalizeMcpServers({
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

  test("skips sse servers with a warning, keeps the rest", () => {
    const { data, warnings } = ConfigMCP.normalizeMcpServers({
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

  test("skips a non-string command with a warning, keeps the rest", () => {
    const { data, warnings } = ConfigMCP.normalizeMcpServers({
      mcpServers: {
        bad: { command: ["firecrawl-mcp"] },
        good: { command: "echo" },
      },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("command is not a string")
    expect(data).toEqual({
      mcp: {
        good: { type: "local", command: ["echo"], enabled: true },
      },
    })
  })

  test("legacy mcp key wins on same-name collision", () => {
    const { data, warnings } = ConfigMCP.normalizeMcpServers({
      mcp: { dup: { type: "local", command: ["legacy"] } },
      mcpServers: { dup: { command: "claude" } },
    })
    expect(warnings).toEqual([])
    expect(data).toEqual({
      mcp: { dup: { type: "local", command: ["legacy"] } },
    })
  })

  test("non-object mcpServers is dropped with a warning", () => {
    const { data, warnings } = ConfigMCP.normalizeMcpServers({
      model: "test/model",
      mcpServers: "oops",
    })
    expect(warnings).toHaveLength(1)
    expect(data).toEqual({ model: "test/model" })
  })

  test("returns config unchanged when mcpServers is absent", () => {
    const input = { model: "test/model", mcp: { s: { type: "local", command: ["x"] } } }
    const { data, warnings } = ConfigMCP.normalizeMcpServers(input)
    expect(warnings).toEqual([])
    expect(data).toEqual(input)
  })
})
