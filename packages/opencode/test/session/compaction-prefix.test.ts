import { expect, test } from "bun:test"

test("compaction reuses the parent request prefix and disables tool calls", async () => {
  const source = await Bun.file(new URL("../../src/session/compaction.ts", import.meta.url)).text()

  expect(source).toContain("buildLLMRequestPrefix")
  expect(source).toContain("prebuiltSystem: prefix.system")
  expect(source).toContain('toolChoice: "none"')
})
