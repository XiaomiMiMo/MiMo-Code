import { describe, expect, mock, test } from "bun:test"
import path from "path"

void mock.module("path", () => ({
  ...path,
  relative: path.win32.relative,
}))

const { AppFileSystem } = await import("@mimo-ai/shared/filesystem")

describe("AppFileSystem Windows path helpers", () => {
  test("contains rejects paths on a different drive", () => {
    expect(AppFileSystem.contains("C:/Users/me/AppData/Local/mimocode/worktree", "D:/workspace/project")).toBe(false)
  })

  test("overlaps rejects paths on a different drive", () => {
    expect(AppFileSystem.overlaps("C:/Users/me/AppData/Local/mimocode/worktree", "D:/workspace/project")).toBe(false)
  })
})
