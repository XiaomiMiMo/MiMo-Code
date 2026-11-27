import { describe, expect, test } from "bun:test"
import { isVersionRequest } from "../../src/cli/version"

describe("version request", () => {
  test.each([
    [["--version"], true],
    [["-v"], true],
    [["run", "--version"], true],
    [["run", "-v"], true],
    [[], false],
    [["run", "-V"], false],
    [["--", "--version"], false],
  ] as const)("recognizes %j", (args, expected) => {
    expect(isVersionRequest([...args])).toBe(expected)
  })
})
