import { describe, expect, test } from "bun:test"
import { AccountTransportError } from "../../src/account/schema"
import { FormatError } from "../../src/cli/error"
import { Failed as MCPFailed } from "../../src/mcp"

describe("cli.error", () => {
  test("formats account transport errors clearly", () => {
    const error = new AccountTransportError({
      method: "POST",
      url: "https://console.mimocode.ai/auth/device/code",
    })

    const formatted = FormatError(error)

    expect(formatted).toContain("Could not reach POST https://console.mimocode.ai/auth/device/code.")
    expect(formatted).toContain("This failed before the server returned an HTTP response.")
    expect(formatted).toContain("Check your network, proxy, or VPN configuration and try again.")
  })

  test("formats MCP auth limitation with mimocode branding", () => {
    const formatted = FormatError(new MCPFailed({ name: "filesystem" }))

    expect(formatted).toBe(
      'MCP server "filesystem" failed. Note, mimocode does not support MCP authentication yet.',
    )
    expect(formatted).not.toContain("opencode")
  })
})
