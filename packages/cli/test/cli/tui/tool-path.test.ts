import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { filetype, normalizePath, toolPathString } from "@/cli/cmd/tui/routes/session/tool-path"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"

// Every field of part.state.input is persisted model output, so the helpers have
// to survive whatever was written there last session - including the object that
// crashed the TUI.
const NON_STRING_INPUTS: [label: string, value: unknown][] = [
  ["an object", { limit: 120, offset: 161 }],
  ["an array", ["a"]],
  ["a number", 42],
  ["a boolean", true],
  ["null", null],
  ["undefined", undefined],
  ["an empty string", ""],
]

const scratchDirs: string[] = []

function makeScratchDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mimo-tool-path-"))
  scratchDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

describe("toolPathString", () => {
  test("keeps non-empty strings and rejects everything else", () => {
    expect(toolPathString("a.ts")).toBe("a.ts")
    for (const [label, value] of NON_STRING_INPUTS) {
      expect({ label, value: toolPathString(value) }).toEqual({ label, value: undefined })
    }
  })
})

describe("guards against non-string tool input", () => {
  for (const [label, value] of NON_STRING_INPUTS) {
    test(`${label} does not throw and degrades to an empty result`, () => {
      expect(() => normalizePath(value)).not.toThrow()
      expect(() => normalizePath(value, { home: os.tmpdir() })).not.toThrow()
      expect(() => filetype(value)).not.toThrow()
      expect(normalizePath(value)).toBe("")
      expect(filetype(value)).toBe("none")
    })
  }

  test("documents the crash the guard prevents", () => {
    // The persisted object used to reach node:path directly, which throws
    // instead of returning a value and takes the whole TUI down with it.
    // @ts-expect-error the whole point is that node:path rejects a non-string
    expect(() => path.isAbsolute({})).toThrow(TypeError)
    // @ts-expect-error extname rejects it the same way
    expect(() => path.extname({})).toThrow(TypeError)
  })
})

describe("normalizePath", () => {
  test("makes paths inside cwd relative", () => {
    expect(normalizePath(path.join(process.cwd(), "a", "b"))).toBe("a/b")
    expect(normalizePath(process.cwd())).toBe(".")
  })

  test("keeps paths outside cwd absolute without a home directory", () => {
    const home = makeScratchDir()
    const target = path.join(home, "nested", "file.ts")
    expect(path.relative(process.cwd(), target).startsWith("..")).toBe(true)

    expect(normalizePath(home)).toBe(home)
    expect(normalizePath(target)).toBe(target)
  })

  test("collapses paths outside cwd but under home to ~", () => {
    const home = makeScratchDir()
    const target = path.join(home, "nested", "file.ts")
    expect(path.relative(process.cwd(), target).startsWith("..")).toBe(true)

    expect(normalizePath(home, { home })).toBe("~")
    expect(normalizePath(target, { home })).toBe(path.join("~", "nested", "file.ts"))
  })

  test("ignores home for paths that are outside both cwd and home", () => {
    const home = makeScratchDir()
    const other = makeScratchDir()
    expect(path.relative(home, other).startsWith("..")).toBe(true)

    expect(normalizePath(other, { home })).toBe(other)
  })
})

describe("filetype", () => {
  test("maps known extensions", () => {
    expect(filetype("a.ts")).toBe("typescript")
    expect(filetype("a.tsx")).toBe("typescript")
    expect(filetype("a.jsx")).toBe("typescript")
  })

  test("falls through to the raw mapping entry for unknown extensions", () => {
    // ".unknown-ext" is not in LANGUAGE_EXTENSIONS, so the lookup miss leaks
    // out instead of "none" - same behaviour the two inline copies had.
    expect(LANGUAGE_EXTENSIONS[".unknown-ext"]).toBeUndefined()
    expect(filetype("a.unknown-ext")).toBe(LANGUAGE_EXTENSIONS[".unknown-ext"])
  })
})
