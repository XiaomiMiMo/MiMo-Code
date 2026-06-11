import { describe, expect, test } from "bun:test"
import { parsePath, buildPath, resolveProjectId } from "../../src/memory/paths"

describe("parsePath", () => {
  test("global scope, key is filename", () => {
    expect(parsePath("/data/memory/global/tooling-prefs.md")).toEqual({
      scope: "global",
      scope_id: "",
      type: "free",
      key: "tooling-prefs",
    })
  })

  test("project memory: <pid>/memory.md", () => {
    expect(parsePath("/data/memory/projects/uuid-1/memory.md")).toEqual({
      scope: "projects",
      scope_id: "uuid-1",
      type: "memory",
      key: "memory",
    })
  })

  test("project memory spillover: <pid>/memory-rules.md", () => {
    expect(parsePath("/data/memory/projects/uuid-1/memory-rules.md")).toEqual({
      scope: "projects",
      scope_id: "uuid-1",
      type: "memory",
      key: "memory-rules",
    })
  })

  test("uppercase MEMORY.md detects as memory type", () => {
    expect(parsePath("/data/memory/projects/uuid-1/MEMORY.md")).toEqual({
      scope: "projects",
      scope_id: "uuid-1",
      type: "memory",
      key: "MEMORY",
    })
  })

  test("uppercase MEMORY-rules.md spillover detects as memory type", () => {
    expect(parsePath("/data/memory/projects/uuid-1/MEMORY-rules.md")).toEqual({
      scope: "projects",
      scope_id: "uuid-1",
      type: "memory",
      key: "MEMORY-rules",
    })
  })

  test("session checkpoint: <sid>/checkpoint.md", () => {
    expect(parsePath("/data/memory/sessions/ses_abc/checkpoint.md")).toEqual({
      scope: "sessions",
      scope_id: "ses_abc",
      type: "checkpoint",
      key: "checkpoint",
    })
  })

  test("session checkpoint spillover: <sid>/checkpoint-lexer.md", () => {
    expect(parsePath("/data/memory/sessions/ses_abc/checkpoint-lexer.md")).toEqual({
      scope: "sessions",
      scope_id: "ses_abc",
      type: "checkpoint",
      key: "checkpoint-lexer",
    })
  })

  test("v4 <sid>/checkpoint/snapshot.md is now free type (legacy)", () => {
    expect(parsePath("/data/memory/sessions/ses_abc/checkpoint/snapshot.md")).toEqual({
      scope: "sessions",
      scope_id: "ses_abc",
      type: "free",
      key: "checkpoint/snapshot",
    })
  })

  test("v4 <pid>/pinned.md is now free type (legacy)", () => {
    expect(parsePath("/data/memory/projects/uuid-1/pinned.md")).toEqual({
      scope: "projects",
      scope_id: "uuid-1",
      type: "free",
      key: "pinned",
    })
  })

  test("task progress", () => {
    expect(parsePath("/data/memory/sessions/ses_abc/tasks/T1.2/progress.md")).toEqual({
      scope: "sessions",
      scope_id: "ses_abc",
      type: "progress",
      key: "tasks/T1.2/progress",
    })
  })

  test("project free file", () => {
    expect(parsePath("/data/memory/projects/abc123def456/conventions.md")).toEqual({
      scope: "projects",
      scope_id: "abc123def456",
      type: "free",
      key: "conventions",
    })
  })

  test("nested key under task", () => {
    expect(parsePath("/data/memory/sessions/ses_abc/tasks/T3/notes/auth.md")).toEqual({
      scope: "sessions",
      scope_id: "ses_abc",
      type: "free",
      key: "tasks/T3/notes/auth",
    })
  })

  test("non-memory path returns null", () => {
    expect(parsePath("/data/checkpoints/ses_abc/001.md")).toBeNull()
  })

  test("session task narrative: progress.md under sessions scope (multi-segment key)", () => {
    expect(parsePath("/data/memory/sessions/ses_abc/tasks/T1/progress.md")).toEqual({
      scope: "sessions",
      scope_id: "ses_abc",
      type: "progress",
      key: "tasks/T1/progress",
    })
  })


  test("session task narrative: notes.md under sessions scope", () => {
    expect(parsePath("/data/memory/sessions/ses_abc/tasks/T1/notes.md")).toEqual({
      scope: "sessions",
      scope_id: "ses_abc",
      type: "notes",
      key: "tasks/T1/notes",
    })
  })

  test("multi-segment notes path falls back to free type (not notes)", () => {
    // Aligns with memory-path-guard's TASK_NARR_RE which only allows bare
    // notes.md — multi-segment notes/<sub>.md is not part of the writer
    // allowlist, so it shouldn't be tagged with the privileged "notes" type.
    expect(parsePath("/data/memory/sessions/ses_abc/tasks/T1/notes/draft.md")).toEqual({
      scope: "sessions",
      scope_id: "ses_abc",
      type: "free",
      key: "tasks/T1/notes/draft",
    })
  })

  test("legacy <root>/tasks/<id>/ path no longer matches (tasks dropped from Scope)", () => {
    expect(parsePath("/data/memory/tasks/T1/progress.md")).toBeNull()
  })
})

describe("buildPath", () => {
  test("session checkpoint", () => {
    expect(
      buildPath({ root: "/data/memory", scope: "sessions", scope_id: "ses_abc", key: "checkpoint" }),
    ).toBe("/data/memory/sessions/ses_abc/checkpoint.md")
  })

  test("global free", () => {
    expect(buildPath({ root: "/data/memory", scope: "global", key: "tooling" })).toBe(
      "/data/memory/global/tooling.md",
    )
  })

  test("rejects key with .. segment", () => {
    expect(() =>
      buildPath({ root: "/data/memory", scope: "sessions", scope_id: "ses_abc", key: "../escape" }),
    ).toThrow(/invalid path component/)
  })

  test("rejects scope_id with .. segment", () => {
    expect(() =>
      buildPath({ root: "/data/memory", scope: "sessions", scope_id: "..", key: "checkpoint" }),
    ).toThrow(/invalid path component/)
  })

  test("rejects key starting with /", () => {
    expect(() =>
      buildPath({ root: "/data/memory", scope: "global", key: "/etc/passwd" }),
    ).toThrow(/invalid path component/)
  })

  test("rejects scope_id starting with /", () => {
    expect(() =>
      buildPath({ root: "/data/memory", scope: "sessions", scope_id: "/abs", key: "checkpoint" }),
    ).toThrow(/invalid path component/)
  })

  test("rejects nested .. inside multi-segment key", () => {
    expect(() =>
      buildPath({ root: "/data/memory", scope: "sessions", scope_id: "ses_abc", key: "tasks/T1/notes/../sneak" }),
    ).toThrow(/invalid path component/)
  })
})

describe("resolveProjectId", () => {
  test("returns 12-char hex from absolute path", () => {
    const id = resolveProjectId("/Users/me/projects/foo")
    expect(id).toMatch(/^[a-f0-9]{12}$/)
  })

  test("same input → same id (deterministic)", () => {
    expect(resolveProjectId("/Users/me/projects/foo")).toBe(resolveProjectId("/Users/me/projects/foo"))
  })

  test("different input → different id", () => {
    expect(resolveProjectId("/a")).not.toBe(resolveProjectId("/b"))
  })
})
