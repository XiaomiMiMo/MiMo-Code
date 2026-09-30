import { describe, expect, test } from "bun:test"
import { resolveInWorkspace, makeFileHooks } from "../../src/workflow/workspace"
import { tmpdir } from "os"
import { mkdtempSync } from "fs"

describe("resolveInWorkspace", () => {
  test("resolves a relative path inside the root", () => {
    expect(resolveInWorkspace("/ws", "a/b.txt")).toBe("/ws/a/b.txt")
  })

  test("rejects a parent-traversal escape", () => {
    expect(() => resolveInWorkspace("/ws", "../escape")).toThrow(/workspace/)
  })

  test("rejects an absolute path that escapes the root", () => {
    expect(() => resolveInWorkspace("/ws", "/etc/passwd")).toThrow(/workspace/)
  })

  test("allows the root itself and nested dirs", () => {
    expect(resolveInWorkspace("/ws", ".")).toBe("/ws")
    expect(resolveInWorkspace("/ws", "deep/nested/x")).toBe("/ws/deep/nested/x")
  })
})

describe("makeFileHooks read/write/exists", () => {
  test("writeFile then readFile round-trips inside the workspace", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    await hooks.writeFile("out/data.tsv", "a\tb\n")
    expect(await hooks.readFile("out/data.tsv")).toBe("a\tb\n")
  })

  test("readFile of a missing file returns null (not throw)", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    expect(await hooks.readFile("nope.txt")).toBe(null)
  })

  test("exists reflects presence", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    expect(await hooks.exists("x")).toBe(false)
    await hooks.writeFile("x", "1")
    expect(await hooks.exists("x")).toBe(true)
  })

  test("writeFile escaping the workspace throws", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    await expect(hooks.writeFile("../escape", "x")).rejects.toThrow(/workspace/)
  })
})

describe("makeFileHooks glob", () => {
  test("returns workspace-relative matches, lexicographically sorted", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    await hooks.writeFile("src/c.zig", "")
    await hooks.writeFile("src/a.zig", "")
    await hooks.writeFile("src/b.zig", "")
    const r = await hooks.glob("src/*.zig")
    expect(r).toEqual(["src/a.zig", "src/b.zig", "src/c.zig"]) // sorted, relative
  })

  test("empty match set returns []", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    expect(await hooks.glob("nothing/*.x")).toEqual([])
  })

  test("glob cannot escape the workspace via .. or absolute patterns", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    // Create a sibling file OUTSIDE the workspace root.
    const outside = mkdtempSync(`${tmpdir()}/wf-outside-`)
    const { writeFileSync } = await import("fs")
    const pathMod = await import("path")
    writeFileSync(pathMod.join(outside, "secret.txt"), "x")
    // A file INSIDE the workspace (the legitimate match).
    await hooks.writeFile("inside.txt", "y")
    // Parent-traversal and absolute patterns must NOT leak anything outside root.
    expect(await hooks.glob("../wf-outside-*/*")).toEqual([])
    expect(await hooks.glob(`${outside}/*`)).toEqual([])
    expect(await hooks.glob("../*")).toEqual([])
    // A normal in-workspace glob still works.
    expect(await hooks.glob("*.txt")).toEqual(["inside.txt"])
  })
})
