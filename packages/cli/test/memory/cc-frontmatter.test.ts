import { describe, expect, test } from "bun:test"
import { parseCcFrontmatterType } from "../../src/memory/paths"

describe("parseCcFrontmatterType", () => {
  test("feedback type", () => {
    const body = `---
name: cache_ttl
description: prefix cache TTL is per-model
metadata:
  type: feedback
---
Body content here.`
    expect(parseCcFrontmatterType(body)).toBe("feedback")
  })

  test("project type", () => {
    const body = `---
name: x
description: y
metadata:
  type: project
---
body`
    expect(parseCcFrontmatterType(body)).toBe("project")
  })

  test("reference type", () => {
    const body = `---
name: x
metadata:
  type: reference
---
body`
    expect(parseCcFrontmatterType(body)).toBe("reference")
  })

  test("user type", () => {
    const body = `---
metadata:
  type: user
---
body`
    expect(parseCcFrontmatterType(body)).toBe("user")
  })

  test("no frontmatter → null", () => {
    expect(parseCcFrontmatterType("Just a plain markdown body.")).toBeNull()
  })

  test("frontmatter without metadata.type → null", () => {
    const body = `---
name: x
description: y
---
body`
    expect(parseCcFrontmatterType(body)).toBeNull()
  })

  test("unknown metadata.type → null (not in CC_TYPES whitelist)", () => {
    const body = `---
metadata:
  type: bogus
---
body`
    expect(parseCcFrontmatterType(body)).toBeNull()
  })

  test("malformed frontmatter (no closing ---) → null", () => {
    expect(parseCcFrontmatterType("---\nmetadata:\n  type: feedback\n")).toBeNull()
  })

  test("MEMORY.md style (no frontmatter, just bullet list) → null", () => {
    expect(parseCcFrontmatterType("- [Title](file.md) — line\n- [Other](b.md) — line")).toBeNull()
  })

  test("top-level type: outside metadata is ignored", () => {
    // The regex requires the type: line to be indented (under metadata:),
    // so a top-level type: must NOT match.
    const body = `---
type: feedback
---
body`
    expect(parseCcFrontmatterType(body)).toBeNull()
  })
})
