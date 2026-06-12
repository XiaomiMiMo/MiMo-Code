import { describe, expect, test } from "bun:test"
import path from "path"

const root = path.join(import.meta.dir, "..")

describe("npm package branding", () => {
  test("bin wrapper resolves scoped mimocode platform packages", async () => {
    const text = await Bun.file(path.join(root, "bin/mimo")).text()

    expect(text).toContain('const scope = "@mimo-ai/"')
    expect(text).toContain('scope + "mimocode-" + platform + "-" + arch')
    expect(text).toContain('platform === "windows" ? "mimo.exe" : "mimo"')
    expect(text).toContain('path.join(scriptDir, ".mimocode")')
    expect(text).not.toContain('"opencode-" + platform + "-" + arch')
    expect(text).not.toContain('"opencode.exe"')
  })

  test("postinstall links the mimocode binary package", async () => {
    const text = await Bun.file(path.join(root, "script/postinstall.mjs")).text()

    expect(text).toContain("`@mimo-ai/mimocode-${platform}-${arch}`")
    expect(text).toContain('platform === "windows" ? "mimo.exe" : "mimo"')
    expect(text).toContain('path.join(__dirname, "bin", ".mimocode")')
    expect(text).toContain("Failed to setup mimocode binary")
    expect(text).not.toContain("`opencode-${platform}-${arch}`")
    expect(text).not.toContain('".opencode"')
  })
})
