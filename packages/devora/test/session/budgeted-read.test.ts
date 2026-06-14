import { describe, test, expect } from "bun:test"
import { readBudgeted, readBudgetedSectionAware } from "../../src/session/budgeted-read"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

describe("readBudgeted", () => {
  const tmpDir = os.tmpdir()

  test("returns full content when under budget", async () => {
    const file = path.join(tmpDir, "budgeted-test-small.md")
    await fs.writeFile(file, "short content")
    const result = await readBudgeted(file, 1000)
    expect(result?.truncated).toBe(false)
    expect(result?.text).toBe("short content")
  })

  test("truncates with Read hint when over budget", async () => {
    const file = path.join(tmpDir, "budgeted-test-large.md")
    await fs.writeFile(file, "word ".repeat(5000)) // ~5000 tokens
    const result = await readBudgeted(file, 100)
    expect(result?.truncated).toBe(true)
    expect(result?.text).toContain("Truncated at ~100 tokens")
    expect(result?.text).toContain("Read(")
    expect(result?.text).toContain("offset=")
  })

  test("returns undefined for missing file", async () => {
    const result = await readBudgeted("/tmp/nonexistent-xyz.md", 1000)
    expect(result).toBeUndefined()
  })
})

describe("readBudgetedSectionAware", () => {
  const tmpDir = os.tmpdir()

  test("preserves all section headers when content truncated", async () => {
    const file = path.join(tmpDir, "section-aware.md")
    const content = `# Title
## §1 Active intent
_instruction_

${"x ".repeat(2000)}

## §2 Next action
_instruction_

short
`
    await fs.writeFile(file, content)
    const result = await readBudgetedSectionAware(file, 100)
    expect(result?.text).toContain("## §1 Active intent")
    expect(result?.text).toContain("## §2 Next action")
    expect(result?.text).toContain("_instruction_")
  })

  test("preserves spillover index lines (- See ...md) even when truncated", async () => {
    const file = path.join(tmpDir, "spill-aware.md")
    const content = `# Title
## §7 Discovered knowledge
_instruction_

${"y ".repeat(3000)}
- See checkpoint-lexer.md (15 items) — Position type, Token shape

## §9 Live resources
_instruction_
short
`
    await fs.writeFile(file, content)
    const result = await readBudgetedSectionAware(file, 100)
    expect(result?.text).toContain("- See checkpoint-lexer.md")
  })
})
