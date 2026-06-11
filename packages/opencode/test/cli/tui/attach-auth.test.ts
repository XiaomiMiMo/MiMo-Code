import { describe, expect, test } from "bun:test"
import { attachAuthHeaders } from "../../../src/cli/cmd/tui/attach-auth"

function decodeBasicAuth(header: string) {
  return Buffer.from(header.slice("Basic ".length), "base64").toString("utf8")
}

describe("attach auth headers", () => {
  test("uses mimocode as the default basic auth username", () => {
    const headers = attachAuthHeaders({
      password: "123456",
      env: {},
    })

    expect(headers).toBeDefined()
    expect(decodeBasicAuth(headers!.Authorization)).toBe("mimocode:123456")
  })

  test("uses the configured server username when provided", () => {
    const headers = attachAuthHeaders({
      env: {
        MIMOCODE_SERVER_USERNAME: "alice",
        MIMOCODE_SERVER_PASSWORD: "secret",
      },
    })

    expect(headers).toBeDefined()
    expect(decodeBasicAuth(headers!.Authorization)).toBe("alice:secret")
  })
})
