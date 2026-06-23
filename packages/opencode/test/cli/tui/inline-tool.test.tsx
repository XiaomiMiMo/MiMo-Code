/**
 * @file InlineTool / GenericTool spacing render test
 *
 * Verify:
 * 1. `input()` formatter function output is correct
 * 2. GenericTool / PlanExit children contain leading space in source code
 * 3. Other InlineTool components are not affected
 *
 * Note: opentui renderer does not expose text content extraction API,
 *       so UI rendering layer verification is through source code structure check + type check + manual testing.
 */
import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

// ── input() formatter function (extracted from session/index.tsx) ──────────────
function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

describe("input() formatter", () => {
  test("formats memory search args correctly", () => {
    const result = input({
      operation: "search",
      query: "test query",
      scope: "global",
    })
    expect(result).toBe("[operation=search, query=test query, scope=global]")
  })

  test("formats simple string args", () => {
    const result = input({ pattern: "*.ts" })
    expect(result).toBe("[pattern=*.ts]")
  })

  test("omits specified keys", () => {
    const result = input({ operation: "search", query: "test", scope: "global" }, ["scope"])
    expect(result).toBe("[operation=search, query=test]")
  })

  test("returns empty string for no primitives", () => {
    const result = input({ nested: { key: "value" } })
    expect(result).toBe("")
  })
})

// ── Source code structure verification ──────────────────────────────────────────
const SESSION_FILE = path.resolve(__dirname, "../../../src/cli/cmd/tui/routes/session/index.tsx")

function getSessionSource(): string {
  return fs.readFileSync(SESSION_FILE, "utf-8")
}

describe("GenericTool source code spacing", () => {
  let source: string

  test("session/index.tsx should be readable", () => {
    source = getSessionSource()
    expect(source.length).toBeGreaterThan(0)
  })

  test("GenericTool children should have leading space expression", () => {
    source = source || getSessionSource()

    // Find GenericTool InlineTool call
    const genericToolMatch = source.match(
      /<InlineTool icon="⚙" pending="Writing command\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(genericToolMatch).not.toBeNull()

    const children = genericToolMatch![1].trim()
    // children should start with {" "}
    expect(children).toMatch(/^\{" "\}/)
  })

  test("PlanExit children should have leading space expression", () => {
    source = source || getSessionSource()

    // Find PlanExit InlineTool call
    const planExitMatch = source.match(
      /<InlineTool icon="⚙" pending="Asking\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(planExitMatch).not.toBeNull()

    const children = planExitMatch![1].trim()
    // children should start with {" "}
    expect(children).toMatch(/^\{" "\}/)
  })
})

describe("Other InlineTool components should NOT be affected", () => {
  let source: string

  test("session/index.tsx should be readable", () => {
    source = getSessionSource()
    expect(source.length).toBeGreaterThan(0)
  })

  test("Skill children should NOT have leading space (already has 'Skill ' prefix)", () => {
    source = source || getSessionSource()

    const skillMatch = source.match(
      /<InlineTool icon="→" pending="Loading skill\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(skillMatch).not.toBeNull()

    const children = skillMatch![1].trim()
    // children should start with Skill, without leading {" "}
    expect(children).toMatch(/^Skill/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Glob children should NOT have leading space (already has 'Glob ' prefix)", () => {
    source = source || getSessionSource()

    const globMatch = source.match(
      /<InlineTool icon="✱" pending="Finding files\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(globMatch).not.toBeNull()

    const children = globMatch![1].trim()
    expect(children).toMatch(/^Glob/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Grep children should NOT have leading space (already has 'Grep ' prefix)", () => {
    source = source || getSessionSource()

    const grepMatch = source.match(
      /<InlineTool icon="✱" pending="Searching content\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(grepMatch).not.toBeNull()

    const children = grepMatch![1].trim()
    expect(children).toMatch(/^Grep/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("WebFetch children should NOT have leading space", () => {
    source = source || getSessionSource()

    const match = source.match(
      /<InlineTool icon="%" pending="Fetching from the web\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(match).not.toBeNull()

    const children = match![1].trim()
    expect(children).toMatch(/^WebFetch/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Write children should NOT have leading space", () => {
    source = source || getSessionSource()

    const match = source.match(
      /<InlineTool icon="←" pending="Preparing write\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(match).not.toBeNull()

    const children = match![1].trim()
    expect(children).toMatch(/^Write/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Edit children should NOT have leading space", () => {
    source = source || getSessionSource()

    const match = source.match(
      /<InlineTool icon="←" pending="Preparing edit\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(match).not.toBeNull()

    const children = match![1].trim()
    expect(children).toMatch(/^Edit/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Question children should NOT have leading space", () => {
    source = source || getSessionSource()

    const match = source.match(
      /<InlineTool icon="→" pending="Asking questions\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(match).not.toBeNull()

    const children = match![1].trim()
    expect(children).toMatch(/^Asked/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Bash children should NOT have leading space", () => {
    source = source || getSessionSource()

    const match = source.match(
      /<InlineTool icon="\$" pending="Writing command\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(match).not.toBeNull()

    const children = match![1].trim()
    expect(children).not.toMatch(/^\{" "\}/)
  })
})

// ── InlineTool render logic verification ──────────────────────────────────────
describe("InlineTool render logic", () => {
  test("icon and children separated by space in source", () => {
    const source = getSessionSource()

    // Verify InlineTool render template has space between icon and children
    const renderMatch = source.match(
      /<span style=\{\{ fg: props\.iconColor \}\}>\{props\.icon\}<\/span>\s*\{props\.children\}/,
    )
    expect(renderMatch).not.toBeNull()
  })
})
