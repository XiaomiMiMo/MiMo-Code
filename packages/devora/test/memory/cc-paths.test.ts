import { describe, expect, test } from "bun:test"
import { parseCcPath } from "../../src/memory/paths"

// Synthetic absolute paths that satisfy parseCcPath's `.claude/projects`
// anchor without referencing any real machine.
describe("parseCcPath", () => {
  test("standard slug + per-memory file", () => {
    expect(
      parseCcPath("/home/u/.claude/projects/-myproj/memory/feedback_x.md"),
    ).toEqual({
      scope: "cc",
      scope_id: "-myproj",
      type: "free", // type is decided by frontmatter, not path; parser leaves "free"
      key: "feedback_x",
    })
  })

  test("MEMORY.md (the index file)", () => {
    expect(parseCcPath("/home/u/.claude/projects/-myproj/memory/MEMORY.md")).toEqual({
      scope: "cc",
      scope_id: "-myproj",
      type: "free",
      key: "MEMORY",
    })
  })

  test("deeply nested slug with dashes", () => {
    expect(
      parseCcPath(
        "/home/u/.claude/projects/-deeply--nested--slug-with-many-dashes/memory/project_x.md",
      ),
    ).toEqual({
      scope: "cc",
      scope_id: "-deeply--nested--slug-with-many-dashes",
      type: "free",
      key: "project_x",
    })
  })

  test("nested key under memory dir is allowed", () => {
    expect(parseCcPath("/home/u/.claude/projects/-foo/memory/sub/file.md")).toEqual({
      scope: "cc",
      scope_id: "-foo",
      type: "free",
      key: "sub/file",
    })
  })

  test("non-CC path returns null", () => {
    expect(parseCcPath("/data/memory/global/x.md")).toBeNull()
  })

  test("missing /memory/ segment returns null", () => {
    expect(parseCcPath("/home/u/.claude/projects/-foo/something-else.md")).toBeNull()
  })

  test("non-md file returns null", () => {
    expect(parseCcPath("/home/u/.claude/projects/-foo/memory/x.txt")).toBeNull()
  })
})
