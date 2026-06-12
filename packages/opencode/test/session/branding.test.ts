import { describe, expect, test } from "bun:test"
import path from "node:path"

describe("session branding prompts", () => {
  for (const file of ["codex.txt", "copilot-gpt-5.txt", "gemini.txt"]) {
    test(`${file} identifies as mimocode`, async () => {
      const content = await Bun.file(path.resolve(import.meta.dir, "../../src/session/prompt", file)).text()

      expect(content).toMatch(/MiMoCode|mimocode/)
      expect(content).not.toContain("You are OpenCode")
      expect(content).not.toContain("Your name is opencode")
      expect(content).not.toContain("You are opencode")
    })
  }
})
