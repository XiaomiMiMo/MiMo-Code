import { describe, expect, test } from "bun:test"
import { Self } from "../../src/util/self"

/**
 * These assertions describe the DEV shape, because that is what the test runner is:
 * `bun` interpreting a script. The compiled shape is asserted by construction — see
 * `compiled()` — and was verified empirically against a `bun build --compile`
 * binary, which reports `Bun.main` as `/$bunfs/root/<name>`.
 */

describe("self invocation", () => {
  test("recognises a script run as not compiled", () => {
    expect(Self.compiled()).toBe(false)
  })

  test("carries the entry script when the runtime is the executable", () => {
    // Otherwise `bun` alone would be invoked with no program to run.
    const argv = Self.argv("llm-server", "issue")
    expect(argv[0]).toBe(process.execPath)
    expect(argv[1]).toBe(Bun.main)
    expect(argv.slice(2)).toEqual(["llm-server", "issue"])
  })

  test("honours MIMOCODE_BIN_PATH, the override bin/mimo already reads", () => {
    const previous = process.env["MIMOCODE_BIN_PATH"]
    process.env["MIMOCODE_BIN_PATH"] = "/opt/pinned/mimo"
    try {
      // A pinned binary replaces the whole invocation: no runtime, no script.
      expect(Self.argv("llm-server", "status")).toEqual(["/opt/pinned/mimo", "llm-server", "status"])
    } finally {
      if (previous === undefined) delete process.env["MIMOCODE_BIN_PATH"]
      else process.env["MIMOCODE_BIN_PATH"] = previous
    }
  })

  test("never emits the bare string `mimo`, which may not be a command", () => {
    // The whole point: an npx or node_modules launch has no `mimo` on PATH.
    const line = Self.commandLine("llm-server", "issue")
    expect(line.startsWith("mimo ")).toBe(false)
    expect(line).toContain("llm-server issue")
  })

  test("quotes a path containing spaces so the line stays runnable", () => {
    // Real installs live in places like ~/Library/Application Support/...
    const previous = process.env["MIMOCODE_BIN_PATH"]
    process.env["MIMOCODE_BIN_PATH"] = "/Applications/My App/bin/mimo"
    try {
      expect(Self.commandLine("llm-server")).toBe("'/Applications/My App/bin/mimo' llm-server")
    } finally {
      if (previous === undefined) delete process.env["MIMOCODE_BIN_PATH"]
      else process.env["MIMOCODE_BIN_PATH"] = previous
    }
  })

  test("leaves an ordinary path unquoted", () => {
    const previous = process.env["MIMOCODE_BIN_PATH"]
    process.env["MIMOCODE_BIN_PATH"] = "/usr/local/bin/mimo"
    try {
      expect(Self.commandLine("llm-server", "status")).toBe("/usr/local/bin/mimo llm-server status")
    } finally {
      if (previous === undefined) delete process.env["MIMOCODE_BIN_PATH"]
      else process.env["MIMOCODE_BIN_PATH"] = previous
    }
  })

  test("escapes an embedded single quote rather than producing a broken line", () => {
    const previous = process.env["MIMOCODE_BIN_PATH"]
    process.env["MIMOCODE_BIN_PATH"] = "/home/o'brien/bin/mimo"
    try {
      const line = Self.commandLine()
      expect(line).toBe(`'/home/o'\\''brien/bin/mimo'`)
    } finally {
      if (previous === undefined) delete process.env["MIMOCODE_BIN_PATH"]
      else process.env["MIMOCODE_BIN_PATH"] = previous
    }
  })
})
