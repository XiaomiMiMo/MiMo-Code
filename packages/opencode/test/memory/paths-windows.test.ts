import { describe, expect, test } from "bun:test"
import { parsePath, parseCcPath } from "../../src/memory/paths"

describe("parsePath on Windows-style paths", () => {
  test("matches a backslash path (the win32 case that silently failed)", () => {
    // This is the exact shape reconcileMemory produced on Windows. Before the
    // fix, the POSIX-only regex did not match and every file was skipped.
    const loc = parsePath(
      String.raw`C:\Users\Abdo\.local\share\mimocode\memory\global\MEMORY.md`,
    )
    expect(loc).toEqual({ scope: "global", scope_id: "", type: "memory", key: "MEMORY" })
  })

  test("matches a backslash project path and classifies the type", () => {
    const loc = parsePath(String.raw`D:\data\memory\projects\abc123\MEMORY.md`)
    expect(loc?.scope).toBe("projects")
    expect(loc?.scope_id).toBe("abc123")
    expect(loc?.type).toBe("memory")
  })

  test("matches a backslash session checkpoint", () => {
    const loc = parsePath(String.raw`D:\data\memory\sessions\ses_123\checkpoint.md`)
    expect(loc?.scope).toBe("sessions")
    expect(loc?.type).toBe("checkpoint")
  })

  test("classifies task progress on a backslash path", () => {
    const loc = parsePath(String.raw`D:\data\memory\sessions\ses_123\tasks\T1\progress.md`)
    expect(loc?.type).toBe("progress")
  })

  test("still matches POSIX paths unchanged", () => {
    const loc = parsePath("/home/u/.local/share/mimocode/memory/global/MEMORY.md")
    expect(loc).toEqual({ scope: "global", scope_id: "", type: "memory", key: "MEMORY" })
  })

  test("posix and windows forms of the same file agree", () => {
    const posix = parsePath("/data/memory/projects/p1/MEMORY.md")
    const win = parsePath(String.raw`\data\memory\projects\p1\MEMORY.md`)
    expect(win).toEqual(posix)
  })

  test("still returns null for a path outside the memory layout", () => {
    expect(parsePath(String.raw`C:\Users\Abdo\notes\MEMORY.md`)).toBeNull()
  })
})

describe("parseCcPath on Windows-style paths", () => {
  test("matches a backslash Claude Code memory path", () => {
    const loc = parseCcPath(String.raw`C:\Users\Abdo\.claude\projects\-home-u-app\memory\notes.md`)
    expect(loc).toEqual({ scope: "cc", scope_id: "-home-u-app", type: "free", key: "notes" })
  })

  test("still matches POSIX Claude Code memory paths", () => {
    const loc = parseCcPath("/home/u/.claude/projects/-home-u-app/memory/notes.md")
    expect(loc?.scope).toBe("cc")
    expect(loc?.scope_id).toBe("-home-u-app")
  })
})
