import { describe, expect, test } from "bun:test"
import path from "path"
import { resolveDevoraHome } from "@devora-ai/shared/global"

describe("resolveDevoraHome", () => {
  test("with DEVORA_HOME set, resolves 4 subdirs under root", () => {
    const result = resolveDevoraHome({
      DEVORA_HOME: "/tmp/profile-a",
    })
    expect(result.mode).toBe("devora_home")
    expect(result.root).toBe("/tmp/profile-a")
    expect(result.config).toBe(path.join("/tmp/profile-a", "config"))
    expect(result.data).toBe(path.join("/tmp/profile-a", "data"))
    expect(result.state).toBe(path.join("/tmp/profile-a", "state"))
    expect(result.cache).toBe(path.join("/tmp/profile-a", "cache"))
  })

  test("without DEVORA_HOME, falls through to xdg mode", () => {
    const result = resolveDevoraHome({})
    expect(result.mode).toBe("xdg")
    expect(result.root).toBeUndefined()
    // xdg paths end with "/devora"
    expect(result.config.endsWith(path.join("", "devora"))).toBe(true)
    expect(result.data.endsWith(path.join("", "devora"))).toBe(true)
    expect(result.state.endsWith(path.join("", "devora"))).toBe(true)
    expect(result.cache.endsWith(path.join("", "devora"))).toBe(true)
  })

  test("empty DEVORA_HOME string is treated as unset (xdg mode)", () => {
    const result = resolveDevoraHome({ DEVORA_HOME: "" })
    expect(result.mode).toBe("xdg")
  })

  test("relative DEVORA_HOME path throws with clear error", () => {
    expect(() => resolveDevoraHome({ DEVORA_HOME: "./foo" })).toThrow(
      /DEVORA_HOME must be an absolute path/,
    )
    expect(() => resolveDevoraHome({ DEVORA_HOME: "foo/bar" })).toThrow(
      /DEVORA_HOME must be an absolute path/,
    )
  })

  test("tilde-prefixed DEVORA_HOME throws (not treated as absolute)", () => {
    expect(() => resolveDevoraHome({ DEVORA_HOME: "~/profiles/a" })).toThrow(
      /DEVORA_HOME must be an absolute path/,
    )
  })

  test("error message includes the offending value", () => {
    expect(() => resolveDevoraHome({ DEVORA_HOME: "./relative" })).toThrow(
      /\.\/relative/,
    )
  })
})
