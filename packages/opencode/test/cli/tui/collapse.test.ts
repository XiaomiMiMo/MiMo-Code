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
  test("reserves the scrollbox chrome and the block border, with a floor", () => {
    expect(Collapse.columns(120)).toBe(114)
    expect(Collapse.columns(10)).toBe(20)
  })
})

describe("collapse display width", () => {
  test("counts CJK as two cells", () => {
    expect(Collapse.rows("中".repeat(60), 100)).toBe(2)
    expect(Collapse.rows("a".repeat(60), 100)).toBe(1)
  })

  test("counts an emoji as two cells", () => {
    expect(Collapse.rows("👍".repeat(15), 20)).toBe(2)
  })

  test("slices CJK on the cell budget, not the character count", () => {
    expect(Collapse.clip("中".repeat(200), 100, 2)).toBe(`${"中".repeat(100)}\n…`)
  })

  test("stops before a wide character that would overflow the last cell", () => {
    // 21 cells: the leading "x" plus 10 CJK chars fill it; an 11th needs cell 22
    expect(Collapse.clip(`x${"中".repeat(50)}`, 21, 1)).toBe(`x${"中".repeat(10)}\n…`)
  })

  test("charges a tab at least one cell (Bun.stringWidth reports 0)", () => {
    expect(Collapse.rows("\t".repeat(30), 20)).toBe(2)
    expect(Collapse.rows("\ta\tb", 20)).toBe(1)
  })

  // Bun.stringWidth is not additive over code points: "❤️" is U+2764 U+FE0F and
  // measures 2 whole but 1 + 0 summed. A per-code-point walk under-charged it and
  // clipped twice the requested height.
  test("clipped content never exceeds the budget, whatever the grapheme", () => {
    for (const glyph of ["❤️", "1️⃣", "👨‍👩‍👦", "中", "a", "\t"]) {
      const clipped = Collapse.clip(glyph.repeat(200), 20, 2)
      expect(Collapse.rows(clipped.replace(/\n…$/, ""), 20)).toBeLessThanOrEqual(2)
    }
  })

  test("keeps a variation-selector emoji whole rather than splitting it", () => {
    expect(Collapse.clip("❤️".repeat(200), 20, 1)).toBe(`${"❤️".repeat(10)}\n…`)
  })

  test("keeps one cluster even when it is wider than the whole budget", () => {
    // three stacked Hangul jamo segment as a single cluster four cells wide, so a
    // 2-cell budget cannot fit it — without the guard the head comes back empty
    const jamo = "\u1100\u1161\u11A8"
    expect(Bun.stringWidth(jamo)).toBe(4)
    expect(Collapse.clip(jamo.repeat(30), 2, 1)).toBe(`${jamo}\n…`)
  })
})
