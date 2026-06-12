import { describe, expect, test } from "bun:test"
import path from "node:path"

describe("upgrade command branding", () => {
  test("uses mimocode in user-visible upgrade messages", async () => {
    const source = await Bun.file(path.resolve(import.meta.dir, "../../src/cli/cmd/upgrade.ts")).text()

    expect(source).toContain("upgrade mimocode to the latest or a specific version")
    expect(source).toContain("mimocode is installed to")
    expect(source).toContain("mimocode upgrade skipped")
    expect(source).not.toContain("upgrade opencode")
    expect(source).not.toContain("opencode is installed to")
    expect(source).not.toContain("opencode upgrade skipped")
  })
})
