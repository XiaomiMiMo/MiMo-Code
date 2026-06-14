import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { SessionID } from "../../src/session/schema"
import { ProjectID } from "../../src/project/schema"
import { notesPath, globalMemoryPath, memoryPath, migrateProjectMemory } from "../../src/session/checkpoint-paths"

describe("notesPath (F14)", () => {
  test("resolves to <data>/memory/sessions/<sid>/notes.md", () => {
    const sid = SessionID.make("ses_test_xyz")
    expect(notesPath(sid)).toBe(path.join(Global.Path.data, "memory", "sessions", sid, "notes.md"))
  })
})

describe("globalMemoryPath", () => {
  test("returns <data>/memory/global/MEMORY.md", () => {
    expect(globalMemoryPath()).toBe(
      path.join(Global.Path.data, "memory", "global", "MEMORY.md"),
    )
  })
})

describe("migrateProjectMemory", () => {
  test("renames legacy memory.md to MEMORY.md when only legacy exists", async () => {
    const pid = ProjectID.make(`p_test_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    const upper = memoryPath(pid)
    const dir = path.dirname(upper)
    const lower = path.join(dir, "memory.md")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(lower, "legacy content")

    await migrateProjectMemory(pid)

    expect(await Bun.file(upper).text()).toBe("legacy content")
    expect(await Bun.file(lower).exists()).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("no-op when MEMORY.md already exists", async () => {
    const pid = ProjectID.make(`p_test_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    const upper = memoryPath(pid)
    const dir = path.dirname(upper)
    const lower = path.join(dir, "memory.md")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(upper, "new content")
    await fs.writeFile(lower, "stale legacy")

    await migrateProjectMemory(pid)

    // Existing MEMORY.md is authoritative; legacy left untouched (not clobbered).
    expect(await Bun.file(upper).text()).toBe("new content")
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("no-op when neither file exists", async () => {
    const pid = ProjectID.make(`p_test_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    await migrateProjectMemory(pid) // must not throw
    expect(await Bun.file(memoryPath(pid)).exists()).toBe(false)
  })

  test("concurrent migrators on same project: loser's ENOENT is tolerated, content preserved", async () => {
    const pid = ProjectID.make(`p_test_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    const upper = memoryPath(pid)
    const dir = path.dirname(upper)
    const lower = path.join(dir, "memory.md")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(lower, "legacy content")

    // Both pass the exists() checks before either rename runs; the loser's
    // rename hits ENOENT and must be swallowed, not thrown.
    const results = await Promise.allSettled([migrateProjectMemory(pid), migrateProjectMemory(pid)])
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    expect(await Bun.file(upper).text()).toBe("legacy content")
    expect(await Bun.file(lower).exists()).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
