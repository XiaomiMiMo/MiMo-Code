import { describe, expect, test } from "bun:test"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"

describe("cli upgrade command", () => {
  test("uses mimocode branding in user-visible upgrade messages", () => {
    const handler = UpgradeCommand.handler.toString()

    expect(handler).toContain("mimocode is installed to")
    expect(handler).toContain("mimocode upgrade skipped")
    expect(handler).not.toContain("opencode is installed to")
    expect(handler).not.toContain("opencode upgrade skipped")
  })
})
