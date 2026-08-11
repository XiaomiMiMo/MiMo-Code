import { describe, expect, test } from "bun:test"
import { timingSafeStringEqual } from "../../src/util/crypto"

describe("experimental http api authorization", () => {
  test("compares server passwords with a timing-safe helper", async () => {
    expect(timingSafeStringEqual("secret", "secret")).toBe(true)
    expect(timingSafeStringEqual("secret", "wrong!")).toBe(false)
    expect(timingSafeStringEqual("secret", "secret-extra")).toBe(false)

    const source = await Bun.file(
      new URL("../../src/server/routes/instance/httpapi/server.ts", import.meta.url),
    ).text()

    expect(source).toContain("timingSafeStringEqual")
    expect(source).not.toContain("Redacted.value(credential.password) !== Flag.MIMOCODE_SERVER_PASSWORD")
  })
})
