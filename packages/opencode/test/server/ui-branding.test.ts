import { describe, expect, test } from "bun:test"

describe("web UI branding", () => {
  test("does not fall back to the OpenCode hosted app", async () => {
    const source = await Bun.file("src/server/routes/ui.ts").text()
    expect(source).not.toContain("app.opencode.ai")
    expect(source).toContain("MiMo Code Web UI")
  })

  test("uses MiMo Code as the app document title", async () => {
    const html = await Bun.file("../app/index.html").text()
    expect(html).toContain("<title>MiMo Code</title>")
    expect(html).not.toContain("<title>OpenCode</title>")
  })
})
