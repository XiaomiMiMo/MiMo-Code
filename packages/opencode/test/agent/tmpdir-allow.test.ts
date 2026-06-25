import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Permission } from "../../src/permission"
import { tmpDirAllowGlobs } from "../../src/agent/agent"

describe("Agent tmpDirAllowGlobs", () => {
  test("includes /tmp, /private/tmp and os.tmpdir() globs", () => {
    const globs = tmpDirAllowGlobs()
    expect(globs).toContain("/tmp/*")
    expect(globs).toContain("/private/tmp/*")
    expect(globs).toContain(path.join(os.tmpdir(), "*"))
  })

  test("contains no duplicate globs", () => {
    const globs = tmpDirAllowGlobs()
    expect(new Set(globs).size).toBe(globs.length)
  })

  test("a temp file path resolves to allow via these globs", () => {
    const ruleset = Permission.fromConfig({
      external_directory: {
        "*": "ask",
        ...Object.fromEntries(tmpDirAllowGlobs().map((dir) => [dir, "allow"])),
      },
    })
    expect(Permission.evaluate("external_directory", "/tmp/scratch.py", ruleset).action).toBe("allow")
    expect(Permission.evaluate("external_directory", "/tmp/sub/nested.json", ruleset).action).toBe("allow")
    expect(Permission.evaluate("external_directory", path.join(os.tmpdir(), "x.txt"), ruleset).action).toBe("allow")
  })

  test("user deny overrides the temp allow", () => {
    const ruleset = Permission.merge(
      Permission.fromConfig({
        external_directory: {
          "*": "ask",
          ...Object.fromEntries(tmpDirAllowGlobs().map((dir) => [dir, "allow"])),
        },
      }),
      Permission.fromConfig({ external_directory: { "/tmp/*": "deny" } }),
    )
    expect(Permission.evaluate("external_directory", "/tmp/scratch.py", ruleset).action).toBe("deny")
  })

  test("non-temp external path still asks", () => {
    const ruleset = Permission.fromConfig({
      external_directory: {
        "*": "ask",
        ...Object.fromEntries(tmpDirAllowGlobs().map((dir) => [dir, "allow"])),
      },
    })
    expect(Permission.evaluate("external_directory", "/etc/passwd", ruleset).action).toBe("ask")
  })
})
