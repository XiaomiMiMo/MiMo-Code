import { describe, expect, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import { trimDiff } from "../../src/util/trim-diff"

const block = (indent: string, changed: string) =>
  ["a", "b", changed, "d", "e"].map((value) => `${indent}const ${value} = 1`).join("\n") + "\n"

describe("util.trimDiff", () => {
  test("strips the indentation shared by every hunk line of a file", () => {
    const diff = createTwoFilesPatch("f.ts", "f.ts", block("    ", "c"), block("    ", "z"))
    expect(trimDiff(diff)).toBe(
      [
        "Index: f.ts",
        "===================================================================",
        "--- f.ts",
        "+++ f.ts",
        "@@ -1,5 +1,5 @@",
        " const a = 1",
        " const b = 1",
        "-const c = 1",
        "+const z = 1",
        " const d = 1",
        " const e = 1",
        "",
      ].join("\n"),
    )
  })

  test("leaves a hunk that touches column zero unchanged", () => {
    const before = "function f() {\n  return 1\n}\n"
    const diff = createTwoFilesPatch("f.ts", "f.ts", before, before.replace("1", "2"))
    expect(trimDiff(diff)).toBe(diff)
  })

  test("trims each file of a multi-file patch independently", () => {
    const deep = createTwoFilesPatch("deep.ts", "deep.ts", block("        ", "c"), block("        ", "z"))
    const shallow = createTwoFilesPatch("shallow.ts", "shallow.ts", block("  ", "c"), block("  ", "z"))
    const flat = createTwoFilesPatch("flat.ts", "flat.ts", block("", "c"), block("", "z"))
    const combined = [deep, shallow, flat].join("\n") + "\n"

    expect(trimDiff(combined)).toBe([trimDiff(deep), trimDiff(shallow), flat].join("\n") + "\n")
    expect(trimDiff(deep)).toContain("\n-const c = 1\n+const z = 1\n")
    expect(trimDiff(shallow)).toContain("\n-const c = 1\n+const z = 1\n")
  })

  test("returns text without hunk lines unchanged", () => {
    expect(trimDiff("")).toBe("")
    expect(trimDiff("Wrote file successfully.")).toBe("Wrote file successfully.")
  })
})
