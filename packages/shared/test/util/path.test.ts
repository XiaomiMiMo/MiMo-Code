import { describe, expect, test } from "bun:test"
import { getDirectory, getFileExtension, getFilename } from "../../src/util/path"

describe("path utilities", () => {
  test("gets filenames from slash and backslash paths", () => {
    expect(getFilename("src/index.ts")).toBe("index.ts")
    expect(getFilename("src\\index.ts")).toBe("index.ts")
    expect(getFilename("README.md/")).toBe("README.md")
  })

  test("returns an empty directory for bare filenames", () => {
    expect(getDirectory("README.md")).toBe("")
    expect(getDirectory("README.md/")).toBe("")
  })

  test("gets directory labels for nested paths", () => {
    expect(getDirectory("src/index.ts")).toBe("src/")
    expect(getDirectory("src/components/button.tsx")).toBe("src/components/")
    expect(getDirectory("src\\components\\button.tsx")).toBe("src/components/")
  })

  test("returns an empty extension for files without one", () => {
    expect(getFileExtension("README")).toBe("")
    expect(getFileExtension(".gitignore")).toBe("")
  })

  test("gets file extensions from filenames", () => {
    expect(getFileExtension("README.md")).toBe("md")
    expect(getFileExtension("archive.tar.gz")).toBe("gz")
    expect(getFileExtension("src/archive.tar.gz")).toBe("gz")
  })
})
