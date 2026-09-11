import { describe, expect, test } from "bun:test"
import { createPatch } from "diff"
import { normalize, text } from "./session-diff"

describe("session diff", () => {
  test.each([
    ["one\ntwo", "one\nthree"],
    ["one\ntwo\n", "one\nthree"],
    ["one\ntwo", "one\nthree\n"],
    ["one\ntwo", "three\ntwo"],
    ["", "one\n"],
    ["one\n", ""],
  ])("preserves patch line endings for %j -> %j", (before, after) => {
    const view = normalize({
      file: "endings.ts",
      patch: createPatch("endings.ts", before, after),
      additions: 1,
      deletions: 1,
    })
    expect(text(view, "deletions")).toBe(before)
    expect(text(view, "additions")).toBe(after)
  })

  test("keeps unified patch content", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toBe(diff.patch)
    expect(view.fileDiff.name).toBe("a.ts")
    expect(text(view, "deletions")).toBe("one\ntwo\n")
    expect(text(view, "additions")).toBe("one\nthree\n")
  })

  test("converts legacy content into a patch", () => {
    const diff = {
      file: "a.ts",
      before: "one\n",
      after: "two\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toContain("@@ -1,1 +1,1 @@")
    expect(text(view, "deletions")).toBe("one\n")
    expect(text(view, "additions")).toBe("two\n")
  })
})
