import { describe, expect, test } from "bun:test"
import { validateSnapshot, TOPIC_MAX_CHARS, validateLearning, validateMemory, validateProgress, validateBudget, validateBudgetSections } from "../../src/session/checkpoint-validator"
import { CHECKPOINT_SECTION_BUDGETS } from "../../src/session/checkpoint-templates"

describe("validateSnapshot", () => {
  const valid = `Topic: parseDecl handles forward declarations in unifier

### Execution context
(none)

### Live resources
(none)

### Session metadata
(none)
`

  test("valid snapshot passes", () => {
    expect(validateSnapshot(valid, "snapshot-001.md")).toEqual([])
  })

  test("missing Topic line errors", () => {
    const body = valid.replace(/^Topic:.*\n/, "")
    const v = validateSnapshot(body, "snapshot-001.md")
    expect(v).toContainEqual(expect.objectContaining({ rule: "topic-missing", severity: "error" }))
  })

  test("Topic > 80 chars warns", () => {
    const long = "x".repeat(TOPIC_MAX_CHARS + 10)
    const body = valid.replace(/^Topic:.*$/m, `Topic: ${long}`)
    const v = validateSnapshot(body, "snapshot-001.md")
    expect(v).toContainEqual(expect.objectContaining({ rule: "topic-too-long", severity: "warn" }))
  })

  test("# Checkpoint #N first line errors", () => {
    const body = `# Checkpoint #007\n\n${valid}`
    const v = validateSnapshot(body, "snapshot-007.md")
    expect(v).toContainEqual(
      expect.objectContaining({ rule: "topic-anti-pattern-checkpoint-header", severity: "error" }),
    )
  })

  test("missing required sub-section errors", () => {
    const body = valid.replace("### Live resources\n(none)\n\n", "")
    const v = validateSnapshot(body, "snapshot-001.md")
    expect(v).toContainEqual(expect.objectContaining({ rule: "subsection-missing", severity: "error" }))
  })

  test("sub-sections out of order errors", () => {
    const reordered = `Topic: ok

### Live resources
(none)

### Execution context
(none)

### Session metadata
(none)
`
    const v = validateSnapshot(reordered, "snapshot-001.md")
    expect(v).toContainEqual(expect.objectContaining({ rule: "subsection-out-of-order", severity: "error" }))
  })
})

describe("validateLearning", () => {
  const valid = `Topic: unifier handles forward declarations

### Discovered
- forward declarations are inert until resolved
  Why: parser emits placeholder TokenKind.Forward
  How to apply: when seeing TokenKind.Forward, look up the resolved sibling

### Dead ends
- (none)
`

  test("valid passes with empty priorTitles", () => {
    expect(validateLearning(valid, "learning-001.md", new Set())).toEqual([])
  })

  test("duplicate Discovered title vs prior errors", () => {
    const prior = new Set(["forward declarations are inert until resolved"])
    const v = validateLearning(valid, "learning-005.md", prior)
    expect(v).toContainEqual(
      expect.objectContaining({ rule: "discovered-duplicate-title", severity: "error" }),
    )
  })

  test("Discovered missing Why warns", () => {
    const body = valid.replace(/  Why:.*\n/, "")
    const v = validateLearning(body, "learning-001.md", new Set())
    expect(v).toContainEqual(
      expect.objectContaining({ rule: "discovered-missing-why", severity: "warn" }),
    )
  })

  test("Discovered missing How to apply warns", () => {
    const body = valid.replace(/  How to apply:.*\n/, "")
    const v = validateLearning(body, "learning-001.md", new Set())
    expect(v).toContainEqual(
      expect.objectContaining({ rule: "discovered-missing-how-to-apply", severity: "warn" }),
    )
  })

  test("missing Topic + missing sections still flagged", () => {
    const body = `### Discovered\n- foo\n  Why: x\n  How to apply: y\n\n### Dead ends\n(none)\n`
    const v = validateLearning(body, "learning-001.md", new Set())
    expect(v).toContainEqual(expect.objectContaining({ rule: "topic-missing" }))
  })

  test("Discovered with (none) placeholder yields no entry violations", () => {
    const body = `Topic: ok\n\n### Discovered\n(none)\n\n### Dead ends\n(none)\n`
    expect(validateLearning(body, "learning-001.md", new Set())).toEqual([])
  })
})

describe("validateMemory", () => {
  const body = `# Pinned

## Directives
- D1: prefer functional methods
- D5: tests must hit a real database
`

  test("valid + no expected revisions passes", () => {
    expect(validateMemory(body, [])).toEqual([])
  })

  test("expected revision text present passes", () => {
    expect(validateMemory(body, [{ id: "D1", expectedText: "functional methods" }])).toEqual([])
  })

  test("expected revision text missing errors", () => {
    const v = validateMemory(body, [{ id: "D1", expectedText: "for-of exception" }])
    expect(v).toContainEqual(expect.objectContaining({ rule: "directive-not-revised", severity: "error" }))
  })
})

describe("validateProgress", () => {
  test("concrete Next passes", () => {
    const body = `## ckpt #5\n- Next: implement parseDecl(line 181)\n`
    expect(validateProgress(body, "progress.md")).toEqual([])
  })

  test("Next: continue warns", () => {
    const body = `## ckpt #5\n- Next: continue\n`
    const v = validateProgress(body, "progress.md")
    expect(v).toContainEqual(expect.objectContaining({ rule: "next-filler", severity: "warn" }))
  })

  test("Next: keep going warns", () => {
    const body = `## ckpt #5\n- Next: keep going\n`
    const v = validateProgress(body, "progress.md")
    expect(v).toContainEqual(expect.objectContaining({ rule: "next-filler", severity: "warn" }))
  })
})

describe("validateBudget", () => {
  test("passes when under budget", () => {
    const violations = validateBudget("short content", 2000, "snapshot.md")
    expect(violations).toEqual([])
  })

  test("emits extract-required when over budget", () => {
    const longContent = "x ".repeat(5000) // ~2500 tokens at 4 chars per token
    const violations = validateBudget(longContent, 2000, "snapshot.md")
    expect(violations).toHaveLength(1)
    expect(violations[0].severity).toBe("extract-required")
    expect(violations[0].rule).toBe("budget-exceeded")
    expect(violations[0].detail).toMatch(/tokens > 2000/)
  })

  test("exact budget boundary passes", () => {
    // 8000 chars / 4 = 2000 tokens exactly
    const content = "a".repeat(8000)
    const violations = validateBudget(content, 2000, "snapshot.md")
    expect(violations).toEqual([])
  })
})

describe("validateBudgetSections", () => {
  test("validateBudgetSections flags over-budget §7 in checkpoint.md", () => {
    const big = "## §7 Discovered knowledge (cross-task)\n_instr_\n" + "- entry ".repeat(2000)
    const violations = validateBudgetSections(big, CHECKPOINT_SECTION_BUDGETS, "checkpoint.md")
    expect(violations.some((v) => v.detail.includes("§7"))).toBe(true)
  })
})

