import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const bashDescription = readFileSync(path.join(import.meta.dir, "../../src/tool/bash.txt"), "utf8")
const writeDescription = readFileSync(path.join(import.meta.dir, "../../src/tool/write.txt"), "utf8")

describe("tool descriptions", () => {
  test("keeps temporary verification scripts out of the workspace", () => {
    for (const description of [bashDescription, writeDescription]) {
      expect(description).toContain("temporary verification")
      expect(description).toContain("OS temp")
      expect(description).toContain("workspace")
      expect(description).toContain("remove")
    }
  })
})
