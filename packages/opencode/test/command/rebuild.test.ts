import { describe, expect, test } from "bun:test"
import path from "path"
import { Command } from "../../src/command"

describe("/rebuild command", () => {
  test("Default has the rebuild name", () => {
    expect(Command.Default.REBUILD).toBe("rebuild")
  })

  test("prompt.ts wires a /rebuild special-case that reuses the shared rebuild helpers", async () => {
    // Source-level guard (mirrors the repo's other prompt.ts wiring guards).
    // The /rebuild command must (a) exist as a special-case in SessionPrompt.command,
    // (b) call the SAME helpers the automatic overflow path uses (so logic/boundary
    // conditions can't drift), and (c) report its outcomes to the user rather than
    // silently no-op.
    //
    // DELIBERATE UPDATE: (b) used to require a direct rebuildFromCheckpoint( call
    // inside the REBUILD block, and (c) used to require the string
    //   "No checkpoint is available to rebuild from yet — continue the
    //    conversation and a checkpoint will be written automatically."
    // Both statements are now wrong, not merely reshaped:
    //   - the manual block calls rebuildEnsuringCheckpoint, which wraps
    //     rebuildFromCheckpoint and adds the start-a-writer-and-wait step the auto
    //     overflow path now shares;
    //   - that no-checkpoint string was deleted because the exit it could still
    //     reach is "a checkpoint WAS written but the rebuild failed", where
    //     advising the user to keep talking so a checkpoint gets written is false.
    // The outcomes are still asserted, against the messages that now exist.
    const promptSrc = await Bun.file(
      path.join(import.meta.dir, "..", "..", "src", "session", "prompt.ts"),
    ).text()

    // (a) special-case dispatch on the rebuild command
    expect(promptSrc).toContain("input.command === Command.Default.REBUILD")
    // (b) reuses the shared helpers (each defined once, called by auto + manual)
    expect(promptSrc).toContain("const rebuildFromCheckpoint = Effect.fn")
    expect(promptSrc).toContain("const rebuildEnsuringCheckpoint = Effect.fn")
    expect(promptSrc).toMatch(
      /if\s*\(input\.command === Command\.Default\.REBUILD\)[\s\S]*?rebuildEnsuringCheckpoint\(/,
    )
    // (c) all three outcomes surfaced to the user
    expect(promptSrc).toContain("Context rebuilt from the latest checkpoint")
    expect(promptSrc).toContain("the context was compacted instead")
    expect(promptSrc).toContain("could not be rebuilt from it")
  })
})
