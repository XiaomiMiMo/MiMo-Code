import { describe, expect, test } from "bun:test"
import path from "path"
import { Command } from "../../src/command"

describe("/rebuild command", () => {
  test("Default has the rebuild name", () => {
    expect(Command.Default.REBUILD).toBe("rebuild")
  })

  test("prompt.ts wires a /rebuild special-case that reuses the shared rebuildFromCheckpoint helper", async () => {
    // Source-level guard (mirrors the repo's other prompt.ts wiring guards).
    // The /rebuild command must (a) exist as a special-case in SessionPrompt.command,
    // (b) call the SAME rebuildFromCheckpoint helper the automatic overflow path
    // uses (so logic/boundary conditions can't drift), and (c) report both the
    // success and no-checkpoint outcomes to the user rather than silently no-op.
    const promptSrc = await Bun.file(
      path.join(import.meta.dir, "..", "..", "src", "session", "prompt.ts"),
    ).text()

    // (a) special-case dispatch on the rebuild command
    expect(promptSrc).toContain("input.command === Command.Default.REBUILD")
    // (b) reuses the shared helper (defined once, called by both auto + manual)
    expect(promptSrc).toContain("const rebuildFromCheckpoint = Effect.fn")
    expect(promptSrc).toMatch(/if\s*\(input\.command === Command\.Default\.REBUILD\)[\s\S]*?rebuildFromCheckpoint\(/)
    // (c) both outcomes surfaced to the user
    expect(promptSrc).toContain("Context rebuilt from the latest checkpoint")
    expect(promptSrc).toContain("No checkpoint is available to rebuild from yet")
  })
})
