import { describe, expect, test } from "bun:test"
import path from "path"
import {
  filetype,
  normalizePath,
  normalizePermissionPath,
  normalizeRunPath,
} from "../../../src/cli/cmd/tui/util/tool-path"

const untrusted = [{}, [], 1, true, false, null, undefined, ""]

describe("tool-path guards", () => {
  test("normalizePath degrades non-strings to empty without throwing", () => {
    for (const value of untrusted) {
      expect(normalizePath(value)).toBe("")
    }
  })

  test("normalizePermissionPath degrades non-strings to empty without throwing", () => {
    for (const value of untrusted) {
      expect(normalizePermissionPath(value)).toBe("")
    }
  })

  test("normalizeRunPath degrades non-strings to empty without throwing", () => {
    for (const value of untrusted) {
      expect(normalizeRunPath(value)).toBe("")
    }
  })

  test("filetype degrades non-strings to none without throwing", () => {
    for (const value of untrusted) {
      expect(filetype(value)).toBe("none")
    }
  })

  test("object path no longer throws from path.isAbsolute", () => {
    expect(() => normalizePath({ nested: true })).not.toThrow()
    expect(() => normalizePermissionPath(["/tmp/example"])).not.toThrow()
    expect(() => normalizeRunPath({ path: "/tmp/example" })).not.toThrow()
    expect(() => filetype({ ext: ".ts" })).not.toThrow()
  })
})

describe("tool-path valid strings", () => {
  test("normalizePath prefers cwd-relative when inside cwd", () => {
    const inside = path.join(process.cwd(), "src", "example.ts")
    expect(normalizePath(inside)).toBe(path.join("src", "example.ts"))
    expect(normalizePath(path.join("src", "example.ts"))).toBe(path.join("src", "example.ts"))
  })

  test("normalizePath keeps absolute paths outside cwd", () => {
    expect(normalizePath("/tmp/example")).toBe(path.resolve("/tmp/example"))
  })

  test("normalizePath maps cwd itself to dot", () => {
    expect(normalizePath(process.cwd())).toBe(".")
    expect(normalizePath(".")).toBe(".")
  })

  test("normalizePermissionPath expands home under HOME/USERPROFILE", () => {
    const home = process.env.HOME || process.env.USERPROFILE
    if (!home) return
    expect(normalizePermissionPath(path.join(home, "notes", "example.md"))).toBe(path.join("~", "notes", "example.md"))
  })

  test("normalizeRunPath relativizes absolute paths and passes relatives through", () => {
    expect(normalizeRunPath(path.join(process.cwd(), "src", "example.ts"))).toBe(path.join("src", "example.ts"))
    expect(normalizeRunPath("src/example.ts")).toBe("src/example.ts")
    expect(normalizeRunPath(process.cwd())).toBe(".")
  })

  test("filetype maps known extensions and collapses jsx to typescript", () => {
    expect(filetype("a.ts")).toBe("typescript")
    expect(filetype("a.tsx")).toBe("typescript")
    expect(filetype("a.md")).toBe("markdown")
    expect(filetype("a.unknownext")).toBeUndefined()
    expect(filetype("a")).toBeUndefined()
  })
})
