import { describe, expect, test } from "bun:test"
import path from "node:path"

describe("fatal error issue branding", () => {
  test("prefills MiMoCode issue metadata", async () => {
    const source = await Bun.file(
      path.resolve(import.meta.dir, "../../src/cli/cmd/tui/component/error-component.tsx"),
    ).text()
    const template = await Bun.file(
      path.resolve(import.meta.dir, "../../../../.github/ISSUE_TEMPLATE/bug-report.yml"),
    ).text()

    expect(source).toContain("https://github.com/XiaomiMiMo/MiMo-Code/issues/new?template=bug-report.yml")
    expect(source).toContain('"opencode-version"')
    expect(source).not.toContain("anomalyco/opencode/issues")
    expect(template).toContain("id: opencode-version")
    expect(template).toContain("label: MiMoCode version")
    expect(template).not.toContain("id: mimocode-version")
  })
})
