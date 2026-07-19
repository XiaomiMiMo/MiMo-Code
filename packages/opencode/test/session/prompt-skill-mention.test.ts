import { describe, expect, test } from "bun:test"

// This regex is duplicated from src/session/prompt.ts:684 to pin its behavior.
// If the source regex changes, this test must be updated to match.
const mentionRe = /(?:^|\s)\/([A-Za-z][A-Za-z0-9_:-]*)(?=[^A-Za-z0-9_:-]|$)/g

function extractMentions(text: string) {
  return [...text.matchAll(mentionRe)].map((m) => m[1])
}

describe("skill mention regex", () => {
  test("captures colon-namespaced skills", () => {
    expect(extractMentions("please use /compose:worktree for this")).toEqual(["compose:worktree"])
  })

  test("captures multiple colon-namespaced skills", () => {
    expect(extractMentions("use /compose:worktree and /compose:tdd together")).toEqual([
      "compose:worktree",
      "compose:tdd",
    ])
  })

  test("captures plain skill names", () => {
    expect(extractMentions("load /effect skill")).toEqual(["effect"])
  })

  test("captures hyphenated skill names", () => {
    expect(extractMentions("use /deep-research for this")).toEqual(["deep-research"])
  })

  test("does not match URL paths", () => {
    expect(extractMentions("visit https://example.com/api")).toEqual([])
  })

  test("does not match slash without preceding whitespace", () => {
    expect(extractMentions("path/to/file")).toEqual([])
  })

  test("captures skill at start of string", () => {
    expect(extractMentions("/compose:brainstorm then implement")).toEqual(["compose:brainstorm"])
  })

  test("does not capture names starting with a digit", () => {
    expect(extractMentions("use /3dscan thing")).toEqual([])
  })
})
