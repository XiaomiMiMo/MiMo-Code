import { describe, expect, test } from "bun:test"
import { BuiltinWorkflow } from "../../src/workflow/builtin"

describe("BuiltinWorkflow registry", () => {
  test("lists deep-research with parsed meta", () => {
    const list = BuiltinWorkflow.list()
    const dr = list.find((w) => w.name === "deep-research")
    expect(dr).toBeDefined()
    expect(dr!.description).toContain("Deep research")
    expect(dr!.whenToUse).toContain("multi-source")
  })

  test("get returns the script body starting with export const meta", () => {
    const dr = BuiltinWorkflow.get("deep-research")
    expect(dr).toBeDefined()
    expect(dr!.script.startsWith("export const meta")).toBe(true)
  })

  test("get returns undefined for an unknown name", () => {
    expect(BuiltinWorkflow.get("nope")).toBeUndefined()
  })

  test("lists compose with parsed meta", () => {
    const list = BuiltinWorkflow.list()
    const c = list.find((w) => w.name === "compose")
    expect(c).toBeDefined()
    expect(c!.description).toContain("compose")
    expect(c!.phases?.length).toBeGreaterThanOrEqual(6)
  })

  test("get('compose') returns the script body starting with export const meta", () => {
    const c = BuiltinWorkflow.get("compose")
    expect(c).toBeDefined()
    expect(c!.script.startsWith("export const meta")).toBe(true)
  })
})
