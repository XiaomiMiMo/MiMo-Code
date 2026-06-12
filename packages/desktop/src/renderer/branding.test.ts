import { describe, expect, test } from "bun:test"
import path from "node:path"

describe("desktop renderer branding", () => {
  test("notifications use bundled MiMoCode favicon", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "index.tsx")).text()

    expect(source).toContain('icon: "./favicon-96x96-v3.png"')
    expect(source).not.toContain("opencode.ai/favicon")
  })
})
