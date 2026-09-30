import { describe, expect, test } from "bun:test"
import { isInlineScript, resolveWorkflowScript } from "../../src/workflow/resolve"
import { tmpdir } from "os"
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import path from "path"

describe("isInlineScript", () => {
  test("a body starting with export const meta is inline", () => {
    expect(isInlineScript(`export const meta = { name: "x", description: "d" }\nreturn 1`)).toBe(true)
  })

  test("leading whitespace/comments before meta still count as inline", () => {
    expect(isInlineScript(`  \n// hi\nexport const meta = {name:"x",description:"d"}`)).toBe(true)
  })

  test("a bare name is NOT inline", () => {
    expect(isInlineScript("phase-a-port")).toBe(false)
  })
})

describe("resolveWorkflowScript", () => {
  test("finds <name>.js under .mimocode/workflows walking up from start", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-res-`)
    const dir = path.join(root, ".mimocode", "workflows")
    mkdirSync(dir, { recursive: true })
    const body = `export const meta = { name: "phase-a", description: "d" }\nreturn 1`
    writeFileSync(path.join(dir, "phase-a.js"), body)
    const sub = path.join(root, "deep", "nested")
    mkdirSync(sub, { recursive: true })
    expect(await resolveWorkflowScript("phase-a", sub, root)).toBe(body)
  })

  test("a name with no matching file returns null", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-res-`)
    expect(await resolveWorkflowScript("missing", root, root)).toBe(null)
  })
})
