import { describe, expect, test } from "bun:test"
import { pluginSdkNpmVersion } from "../../src/installation/version"

// [plugin-sdk-npm-version T1] npm 解析版本与安装身份拆分:
// local / 非 semver 身份（desktop-<hash>）→ 不钉版本；真实 semver 才钉。
describe("pluginSdkNpmVersion", () => {
  test("local install does not pin a package version", () => {
    expect(pluginSdkNpmVersion("local", true)).toBeUndefined()
    expect(pluginSdkNpmVersion("0.1.14", true)).toBeUndefined()
  })

  test("release semver identity pins that exact version", () => {
    expect(pluginSdkNpmVersion("0.1.14", false)).toBe("0.1.14")
    expect(pluginSdkNpmVersion("0.1.3-preview.0", false)).toBe("0.1.3-preview.0")
  })

  test("non-semver install identity falls back to latest (undefined)", () => {
    expect(pluginSdkNpmVersion("desktop-abc1234", false)).toBeUndefined()
    expect(pluginSdkNpmVersion("desktop-0000000", false)).toBeUndefined()
    expect(pluginSdkNpmVersion("preview-build-99", false)).toBeUndefined()
  })
})
