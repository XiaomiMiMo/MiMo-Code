import { describe, expect, test } from "bun:test"
import path from "node:path"

const read = (file: string) => Bun.file(path.join(import.meta.dir, file)).text()

describe("desktop shell branding", () => {
  test("main process uses MiMoCode labels", async () => {
    const index = await read("index.ts")
    const menu = await read("menu.ts")
    const windows = await read("windows.ts")

    expect(index).toContain('prod: "MiMoCode"')
    expect(index).toContain('"MiMoCode Dev"')
    expect(windows).toContain('title: "MiMoCode"')
    expect(menu).toContain('label: "MiMoCode"')
    expect(menu).toContain('label: "MiMoCode Website"')
    expect(menu).toContain("https://mimo.xiaomi.com/en/mimocode")
    expect(menu).toContain('label: "MiMoCode Repository"')
    expect(menu).toContain('label: "MiMoCode Issues"')
    expect(menu).not.toContain("discord.com/invite/opencode")
    expect(menu).not.toContain("OpenCode Documentation")
    expect(menu).not.toContain("anomalyco/opencode/issues")
  })
})
