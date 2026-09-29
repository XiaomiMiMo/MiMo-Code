import { expect, test } from "bun:test"
import { ConfigMCP } from "../../src/config/mcp"

test("MCP server timeout must be positive", () => {
  expect(ConfigMCP.Local.zod.safeParse({ type: "local", command: ["server"], timeout: 1 }).success).toBe(true)
  expect(ConfigMCP.Local.zod.safeParse({ type: "local", command: ["server"], timeout: 0 }).success).toBe(false)
  expect(ConfigMCP.Local.zod.safeParse({ type: "local", command: ["server"], timeout: -1 }).success).toBe(false)
  expect(ConfigMCP.Remote.zod.safeParse({ type: "remote", url: "https://example.test", timeout: 1 }).success).toBe(
    true,
  )
  expect(ConfigMCP.Remote.zod.safeParse({ type: "remote", url: "https://example.test", timeout: 0 }).success).toBe(
    false,
  )
})
