import { describe, expect, test } from "bun:test"
import path from "path"
import { filetype, normalizePath } from "../../../src/cli/cmd/tui/routes/session/index"
import {
  filetype as permissionFiletype,
  normalizePath as permissionNormalizePath,
} from "../../../src/cli/cmd/tui/routes/session/permission"
import { normalizePath as runNormalizePath } from "../../../src/cli/cmd/run"

// Tool-call `input` reaches the renderers unvalidated: `part.state.input` is the raw
// model output and the Zod schema is only applied in the tool's execute(). A model
// that emits a non-string `path`/`file_path` used to reach path.isAbsolute() and throw
// `TypeError: The "path" property must be of type string, got object`, which the
// top-level ErrorBoundary turns into a fatal "A fatal error occurred!" screen that
// replaces the whole session view. Rendering must degrade instead of throwing.

describe("tool-input path guards (session transcript renderers)", () => {
  test("normalizePath returns an empty string instead of throwing for an object path", () => {
    expect(normalizePath({ pattern: "src/**/*.ts" } as any)).toBe("")
  })

  test("normalizePath returns an empty string instead of throwing for an array path", () => {
    expect(normalizePath(["src", "test"] as any)).toBe("")
  })

  test("normalizePath returns an empty string instead of throwing for a numeric path", () => {
    expect(normalizePath(42 as any)).toBe("")
  })

  test("normalizePath returns an empty string instead of throwing for a boolean path", () => {
    expect(normalizePath(true as any)).toBe("")
  })

  test("normalizePath still relativises a real string path", () => {
    const inside = path.join(process.cwd(), "src", "index.ts")
    expect(normalizePath(inside)).toBe(path.join("src", "index.ts"))
  })

  test("normalizePath still returns an empty string for null and undefined", () => {
    expect(normalizePath(null as any)).toBe("")
    expect(normalizePath(undefined)).toBe("")
  })

  test("filetype reports no language instead of throwing for an object file_path", () => {
    expect(filetype({ file_path: "src/index.ts" } as any)).toBe("none")
  })

  test("filetype reports no language instead of throwing for an array file_path", () => {
    expect(filetype(["src/index.ts"] as any)).toBe("none")
  })

  test("filetype still detects a real file extension", () => {
    expect(filetype("src/index.ts")).toBe("typescript")
  })
})

describe("tool-input path guards (permission prompt renderers)", () => {
  test("normalizePath returns an empty string instead of throwing for an object path", () => {
    expect(permissionNormalizePath({ filepath: "C:/Users/me" } as any)).toBe("")
  })

  test("normalizePath returns an empty string instead of throwing for an array path", () => {
    expect(permissionNormalizePath(["C:/Users/me"] as any)).toBe("")
  })

  test("normalizePath still relativises a real string path", () => {
    const inside = path.join(process.cwd(), "src", "index.ts")
    expect(permissionNormalizePath(inside)).toBe(path.join("src", "index.ts"))
  })

  test("filetype reports no language instead of throwing for an object file_path", () => {
    expect(permissionFiletype({ file_path: "src/index.ts" } as any)).toBe("none")
  })

  test("filetype still detects a real file extension", () => {
    expect(permissionFiletype("src/index.ts")).toBe("typescript")
  })
})

// Guards the premise of every test above. Node words this failure differently
// ("The \"path\" argument must be of type string. Received an instance of Object"),
// which is why the bug only ever surfaces in the Bun-compiled build.
describe("premise: the unguarded path API really does throw on these shapes", () => {
  test("path.isAbsolute throws for a non-string argument", () => {
    expect(() => path.isAbsolute({} as any)).toThrow(/must be of type string/)
  })
})

// `mimo run` renders tool calls to stdout with no ErrorBoundary anywhere on that
// path, so the same malformed field aborts the whole headless run.
describe("tool-input path guards (headless `mimo run` renderer)", () => {
  test("normalizePath returns an empty string instead of throwing for an object path", () => {
    expect(runNormalizePath({ file_path: "C:/Users/me" } as any)).toBe("")
  })

  test("normalizePath returns an empty string instead of throwing for an array path", () => {
    expect(runNormalizePath(["src", "test"] as any)).toBe("")
  })

  test("normalizePath still relativises a real absolute string path", () => {
    const inside = path.join(process.cwd(), "src", "index.ts")
    expect(runNormalizePath(inside)).toBe(path.join("src", "index.ts"))
  })

  test("normalizePath still returns a relative string path unchanged", () => {
    expect(runNormalizePath("src/index.ts")).toBe("src/index.ts")
  })
})
