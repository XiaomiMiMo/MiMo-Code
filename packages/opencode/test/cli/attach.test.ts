import { describe, expect, test } from "bun:test"
import { attachAuthHeaders } from "../../src/cli/cmd/tui/attach-auth"

describe("attachAuthHeaders", () => {
  test("uses mimocode as the default server username", () => {
    expect(attachAuthHeaders({ password: "secret", env: {} })).toEqual({
      Authorization: `Basic ${Buffer.from("mimocode:secret").toString("base64")}`,
    })
  })

  test("uses MIMOCODE_SERVER_USERNAME when set", () => {
    expect(
      attachAuthHeaders({
        env: {
          MIMOCODE_SERVER_PASSWORD: "secret",
          MIMOCODE_SERVER_USERNAME: "operator",
        },
      }),
    ).toEqual({
      Authorization: `Basic ${Buffer.from("operator:secret").toString("base64")}`,
    })
  })

  test("omits auth headers without a password", () => {
    expect(attachAuthHeaders({ env: {} })).toBeUndefined()
  })
})
