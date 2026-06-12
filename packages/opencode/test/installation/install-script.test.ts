import { describe, expect, test } from "bun:test"
import path from "path"

const root = path.join(import.meta.dir, "../../../..")

describe("install script", () => {
  test("does not use GitHub API for latest version discovery", async () => {
    const text = await Bun.file(path.join(root, "install")).text()

    expect(text).not.toContain("api.github.com/repos/XiaomiMiMo/MiMo-Code/releases/latest")
    expect(text).toContain("releases/latest")
    expect(text).toContain("url_effective")
    expect(text).toContain('"/releases/tag/v"')
  })
})
