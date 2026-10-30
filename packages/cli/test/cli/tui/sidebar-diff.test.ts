import { expect, test } from "bun:test"
import { sidebarDiff, sidebarPreview } from "../../../src/cli/cmd/tui/util/sidebar-diff"

test("sidebar stores file statistics without patch bodies and caps rendered rows", () => {
  const source = Array.from({ length: 1000 }, (_, i) => ({
    file: `file-${i}`,
    additions: 2,
    deletions: 1,
    patch: "large patch",
  }))
  const rows = sidebarDiff(source)
  expect(rows).toHaveLength(500)
  expect(rows[0]).toEqual({ file: "file-0", additions: 2, deletions: 1 })
  expect(sidebarPreview(rows, 100_000)).toMatchObject({ total: 100_000, omitted: 99_900 })
  expect(sidebarPreview(rows).files).toHaveLength(100)
  expect(sidebarPreview(rows, 0).total).toBe(500)
})
