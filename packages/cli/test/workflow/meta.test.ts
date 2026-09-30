import { describe, expect, test } from "bun:test"
import { parseMeta } from "../../src/workflow/meta"

describe("workflow meta parser", () => {
  test("extracts a literal meta and returns the remaining body", () => {
    const script = [
      `export const meta = { name: "demo", description: "d" }`,
      `return 1 + 1`,
    ].join("\n")
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe("demo")
      expect(result.meta.description).toBe("d")
      expect(result.body).toContain("return 1 + 1")
      expect(result.body).not.toContain("export const meta")
    }
  })

  test("rejects a script with no meta", () => {
    const result = parseMeta(`return 42`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("export const meta")
  })

  test("rejects meta missing required name/description", () => {
    const result = parseMeta(`export const meta = { name: "x" }\nreturn 1`)
    expect(result.ok).toBe(false)
  })

  test("rejects non-literal meta (function call)", () => {
    const result = parseMeta(`export const meta = makeMeta()\nreturn 1`)
    expect(result.ok).toBe(false)
  })

  test("parses meta with a nested phases array and round-trips it", () => {
    const script = [
      `export const meta = { name: "x", description: "d", phases: [{ title: "a", detail: "b" }] }`,
      `return 1`,
    ].join("\n")
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.phases?.[0].title).toBe("a")
      expect(result.meta.phases?.[0].detail).toBe("b")
    }
  })

  test("preserves body line numbers for a multi-line meta", () => {
    const script = [
      `export const meta = {`,
      `  name: "x",`,
      `  description: "d",`,
      `}`,
      `return 1`,
    ].join("\n")
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.body.split("\n").length).toBe(script.split("\n").length)
      expect(result.body).not.toContain("export const meta")
    }
  })

  test("accepts single-quoted string values", () => {
    const result = parseMeta(`export const meta = { name: 'x', description: 'y' }\nreturn 1`)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe("x")
      expect(result.meta.description).toBe("y")
    }
  })

  test("accepts whenToUse and model fields", () => {
    const script = `export const meta = { name: "x", description: "d", whenToUse: "when", model: "anthropic/m" }\nreturn 1`
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.whenToUse).toBe("when")
      expect(result.meta.model).toBe("anthropic/m")
    }
  })

  // --- Security (P0 RCE): the meta literal must be parsed as DATA, never executed
  // in the host realm. These payloads previously ran through `new Function`. ---

  test("does NOT execute the literal in the host realm (sentinel stays untouched)", () => {
    const g = globalThis as unknown as { __pwned?: unknown }
    g.__pwned = undefined
    // If the literal were executed, the comma operator would set the sentinel
    // before yielding "x" as the name.
    parseMeta(`export const meta = { name: (globalThis.__pwned = 1, 'x'), description: 'y' }\nreturn 1`)
    expect(g.__pwned).toBeUndefined()
    delete g.__pwned
  })

  test("rejects a comma-operator / property-access payload as non-data", () => {
    const result = parseMeta(`export const meta = { name: (globalThis.process,'x'), description: 'y' }\nreturn 1`)
    expect(result.ok).toBe(false)
  })

  test("rejects an IIFE / call expression value", () => {
    const result = parseMeta(`export const meta = { name: (() => 'x')(), description: 'y' }\nreturn 1`)
    expect(result.ok).toBe(false)
  })

  test("does NOT execute a require/execSync payload (sentinel-free proof of no host call)", () => {
    const g = globalThis as unknown as { __pwned?: unknown }
    g.__pwned = undefined
    // Mirrors the original advisory payload shape; even if globalThis.process
    // exists, this must be rejected as non-data and must not run.
    parseMeta(
      `export const meta = { name: (globalThis.__pwned = require, 'x'), description: 'y' }\nreturn 1`,
    )
    expect(g.__pwned).toBeUndefined()
    delete g.__pwned
  })

  test("rejects pathologically deep nesting as ok:false (no uncaught throw)", () => {
    const deep = "[".repeat(100000) + "]".repeat(100000)
    const r = parseMeta(`export const meta = { name: "x", description: "y", phases: ${deep} }`)
    expect(r.ok).toBe(false) // a clean rejection, not a RangeError escaping parseMeta
  })

  test("accepts a meta containing a brace inside a // line comment", () => {
    const result = parseMeta(`export const meta = { name: "n", description: "d" // }\n}\nreturn 1`)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe("n")
      expect(result.meta.description).toBe("d")
    }
  })

  test("accepts a meta containing a brace inside a /* */ block comment", () => {
    const result = parseMeta(`export const meta = { name: "n", /* } */ description: "d" }\nreturn 1`)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe("n")
      expect(result.meta.description).toBe("d")
    }
  })

  test("parses a valid permissions manifest", () => {
    const script = [
      `export const meta = { name: "x", description: "d", permissions: [{ permission: "bash", patterns: ["rm *"], always: ["rm *"], reason: "cleanup" }] }`,
      `return 1`,
    ].join("\n")
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.permissions).toEqual([
        { permission: "bash", patterns: ["rm *"], always: ["rm *"], reason: "cleanup" },
      ])
    }
  })

  test("rejects permissions that is not an array", () => {
    const result = parseMeta(`export const meta = { name: "x", description: "d", permissions: "nope" }\nreturn 1`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("meta.permissions must be an array")
  })

  test("rejects a permissions entry missing a permission string", () => {
    const result = parseMeta(`export const meta = { name: "x", description: "d", permissions: [{ reason: "x" }] }\nreturn 1`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("non-empty `permission` string")
  })

  test("rejects patterns that is not an array of strings", () => {
    const result = parseMeta(
      `export const meta = { name: "x", description: "d", permissions: [{ permission: "bash", patterns: [1] }] }\nreturn 1`,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("meta.permissions[].patterns must be an array of strings")
  })

  test("rejects a non-string reason", () => {
    const result = parseMeta(
      `export const meta = { name: "x", description: "d", permissions: [{ permission: "bash", reason: 5 }] }\nreturn 1`,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("meta.permissions[].reason must be a string")
  })
})
