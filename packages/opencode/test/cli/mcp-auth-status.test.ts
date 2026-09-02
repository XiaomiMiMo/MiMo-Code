import { describe, expect, test } from "bun:test"
import { mcpDebugAuthLines } from "../../src/cli/cmd/mcp"

describe("mcp auth status output", () => {
  test("does not print partial access tokens", () => {
    const accessToken = "mcp_secret_access_token_1234567890"
    const output = mcpDebugAuthLines("authenticated", {
      tokens: {
        accessToken,
      },
    }).join("\n")

    expect(output).toContain("Access token: present")
    expect(output).not.toContain(accessToken)
    expect(output).not.toContain(accessToken.slice(0, 20))
  })
})
