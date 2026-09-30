import { describe, expect, test } from "bun:test"
import { CHECKPOINT_TEMPLATE, CHECKPOINT_SECTION_BUDGETS, NOTES_TEMPLATE } from "../../src/session/checkpoint-templates"

describe("Checkpoint templates v8.1", () => {
  test("CHECKPOINT_TEMPLATE includes §10 Design decisions (F13)", () => {
    expect(CHECKPOINT_TEMPLATE).toContain("## §10 Design decisions and discussion outcomes")
    expect(CHECKPOINT_TEMPLATE).toMatch(/§10[\s\S]*Decisions reached through discussion/)
  })

  test("CHECKPOINT_SECTION_BUDGETS includes §10 entry (F13)", () => {
    expect(CHECKPOINT_SECTION_BUDGETS["§10 Design decisions and discussion outcomes"]).toBe(3000)
  })

  test("CHECKPOINT_TEMPLATE includes §11 Open notes (F19)", () => {
    expect(CHECKPOINT_TEMPLATE).toContain("## §11 Open notes")
    expect(CHECKPOINT_TEMPLATE).toMatch(/§11[\s\S]*Writer-curated catch-all/)
  })

  test("CHECKPOINT_SECTION_BUDGETS includes §11 entry (F19)", () => {
    expect(CHECKPOINT_SECTION_BUDGETS["§11 Open notes"]).toBe(800)
  })

  test("NOTES_TEMPLATE exists for new session notes file (F14)", () => {
    expect(NOTES_TEMPLATE).toBeDefined()
    expect(NOTES_TEMPLATE).toContain("# Session notes")
    expect(NOTES_TEMPLATE).toContain("turn N")
    expect(NOTES_TEMPLATE).toContain("YYYY-MM-DDTHH:MM:SSZ")
  })

  test("NOTES_TEMPLATE includes dedupe hint (F33)", () => {
    expect(NOTES_TEMPLATE).toContain("scan existing entries")
  })

  test("composeWriterPrompt renders Section budgets from CHECKPOINT_SECTION_BUDGETS (F43)", async () => {
    const { composeWriterPromptForTest } = await import("../../src/session/checkpoint")
    const out = composeWriterPromptForTest({
      checkpointFile: "/tmp/test/checkpoint.md",
      memoryFile: "/tmp/test/memory.md",
      taskMemDir: "/tmp/test/tasks",
      notesFile: "/tmp/test/notes.md",
      rangeDesc: "test range",
      progressDiff: "",
    })
    // Every section budget must be substituted into the prompt
    for (const [section, budget] of Object.entries(CHECKPOINT_SECTION_BUDGETS)) {
      expect(out).toContain(`${section}: ${budget}`)
    }
    // Placeholder must be substituted out
    expect(out).not.toContain("{{SECTION_BUDGETS}}")
  })
})
