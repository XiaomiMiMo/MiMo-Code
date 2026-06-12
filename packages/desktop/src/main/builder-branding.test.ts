import { describe, expect, test } from "bun:test"
import path from "node:path"

describe("desktop package branding", () => {
  test("builder metadata uses MiMoCode without changing compatibility ids", async () => {
    const config = await Bun.file(path.resolve(import.meta.dir, "../../electron-builder.config.ts")).text()
    const manifest = await Bun.file(path.resolve(import.meta.dir, "../../package.json")).json()

    expect(config).toContain('const artifactPrefix = channel === "beta" ? "mimocode-desktop-beta" : "mimocode-desktop"')
    expect(config).toContain("artifactName: `${artifactPrefix}-\\${os}-\\${arch}.\\${ext}`")
    expect(config).toContain('productName: "MiMoCode"')
    expect(config).toContain('productName: "MiMoCode Dev"')
    expect(config).toContain('productName: "MiMoCode Beta"')
    expect(config).toContain('protocols: { name: "MiMoCode"')
    expect(config).toContain('owner: "XiaomiMiMo"')
    expect(config).toContain('repo: "MiMo-Code"')
    expect(config).toContain('channel: "beta"')
    expect(config).toContain('channel: "latest"')
    expect(config).toContain('schemes: ["opencode"]')
    expect(config).toContain('appId: "ai.opencode.desktop"')
    expect(config).not.toContain('productName: "OpenCode"')
    expect(config).not.toContain('artifactName: "opencode-desktop')
    expect(config).not.toContain("anomalyco")
    expect(manifest.homepage).toBe("https://github.com/XiaomiMiMo/MiMo-Code")
    expect(manifest.author.name).toBe("MiMoCode")
  })
})
