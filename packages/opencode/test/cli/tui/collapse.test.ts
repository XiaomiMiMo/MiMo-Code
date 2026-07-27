import { describe, expect, test } from "bun:test"
import * as Collapse from "../../../src/cli/cmd/tui/util/collapse"

describe("collapse.rows", () => {
  test("counts wrapped height, not source lines", () => {
    expect(Collapse.rows("a".repeat(250), 100)).toBe(3)
    expect(Collapse.rows("short\nshort", 100)).toBe(2)
    expect(Collapse.rows("", 100)).toBe(0)
  })

  test("an empty line still occupies one row", () => {
    expect(Collapse.rows("a\n\nb", 100)).toBe(3)
  })
})

describe("collapse.clip", () => {
  test("returns content untouched when it fits the budget", () => {
    expect(Collapse.clip("a\nb\nc", 100, 10)).toBe("a\nb\nc")
  })

  test("drops whole lines past the budget and marks the cut", () => {
    expect(Collapse.clip("1\n2\n3\n4", 100, 2)).toBe("1\n2\n…")
  })

  test("charges a wrapped line its full height", () => {
    // line 1 wraps to 3 rows, so a 4-row budget fits it plus one more line
    expect(Collapse.clip(`${"a".repeat(250)}\nb\nc`, 100, 4)).toBe(`${"a".repeat(250)}\nb\n…`)
  })

  test("slices a line that straddles the budget instead of dropping it", () => {
    // one 500-char line is 5 rows; a 2-row budget keeps its first 200 chars
    expect(Collapse.clip("x".repeat(500), 100, 2)).toBe(`${"x".repeat(200)}\n…`)
  })

  test("a single huge line still shows its head when the budget starts full", () => {
    const clipped = Collapse.clip(`head\n${"j".repeat(4000)}`, 80, 3)
    expect(clipped.startsWith("head\njjj")).toBe(true)
    expect(clipped.endsWith("\n…")).toBe(true)
    expect(Collapse.rows(clipped.replace(/\n…$/, ""), 80)).toBe(3)
  })
})

describe("collapse.columns", () => {
  test("reserves the block border and padding, with a floor", () => {
    expect(Collapse.columns(120)).toBe(117)
    expect(Collapse.columns(10)).toBe(20)
  })
})
