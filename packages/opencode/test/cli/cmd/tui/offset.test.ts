import { describe, expect, test } from "bun:test"
import {
  charAfterCursor,
  stringIndexToWidth,
  widthToStringIndex,
} from "../../../../src/cli/cmd/tui/component/prompt/offset"

// The editor uses display-width offsets (a wide CJK char counts as 2 columns)
// while plainText is a JS UTF-16 string (a CJK char is 1 unit). These helpers
// translate between the two coordinate systems.
describe("offset conversion", () => {
  test("widthToStringIndex maps a width offset to a UTF-16 index", () => {
    // "你好" is width 4 but 2 UTF-16 units
    expect(widthToStringIndex("你好world", 4)).toBe(2)
    expect(widthToStringIndex("你好world", 6)).toBe(4) // 你好wo
    expect(widthToStringIndex("hello", 3)).toBe(3) // ascii: width == index
  })

  test("stringIndexToWidth maps a UTF-16 index to a width offset", () => {
    expect(stringIndexToWidth("你好world", 2)).toBe(4) // 你好 -> width 4
    expect(stringIndexToWidth("你好world", 4)).toBe(6) // 你好wo
    expect(stringIndexToWidth("hello", 3)).toBe(3)
  })

  test("the two conversions round-trip on character boundaries", () => {
    const text = "前缀@x后缀"
    for (let i = 0; i <= text.length; i++) {
      const width = stringIndexToWidth(text, i)
      expect(widthToStringIndex(text, width)).toBe(i)
    }
  })

  test("counts a newline as width 1 (matching the editor, not Bun.stringWidth)", () => {
    // The editor advances its width offset by 1 per "\n", but Bun.stringWidth("\n")
    // is 0. The converters must follow the editor, otherwise every newline before an
    // offset desyncs the two coordinate systems by one.
    // "你好\n[" — 你好=4, \n=1, so "[" sits at width 5 / string index 3
    expect(stringIndexToWidth("你好\n[", 3)).toBe(5)
    expect(widthToStringIndex("你好\n[", 5)).toBe(3)
  })

  test("round-trips across newlines and CJK together", () => {
    const text = "你好\n世界\nA"
    let index = 0
    for (const ch of text) {
      const width = stringIndexToWidth(text, index)
      expect(widthToStringIndex(text, width)).toBe(index)
      index += ch.length
    }
  })

  test("counts a tab as width 2 (matching the editor, not Bun.stringWidth)", () => {
    // The editor advances its width offset by 2 per "\t", but Bun.stringWidth("\t")
    // is 0. Pasted code often contains tabs, so the converters must follow the editor.
    // "ab\tc" — ab=2, \t=2, so "c" sits at width 4 / string index 3
    expect(stringIndexToWidth("ab\tc", 3)).toBe(4)
    expect(widthToStringIndex("ab\tc", 4)).toBe(3)
  })

  test("round-trips across tabs, newlines and CJK together", () => {
    const text = "你好\t世界\nA\tB"
    let index = 0
    for (const ch of text) {
      const width = stringIndexToWidth(text, index)
      expect(widthToStringIndex(text, width)).toBe(index)
      index += ch.length
    }
  })

  test("round-trips across supplementary-plane (emoji) code-point boundaries", () => {
    // 😀 is one code point but 2 UTF-16 units and display width 2. The converters
    // are only contracted to agree on real code-point boundaries (the editor never
    // emits an offset that splits a surrogate pair), so iterate by code point.
    const text = "a😀好b"
    let index = 0
    for (const ch of text) {
      const width = stringIndexToWidth(text, index)
      expect(widthToStringIndex(text, width)).toBe(index)
      index += ch.length
    }
  })
})

describe("charAfterCursor", () => {
  test("reads the char right after the cursor in pure ascii", () => {
    // "ab cd", cursor (width 2) sits before the space
    expect(charAfterCursor("ab cd", 2)).toBe(" ")
  })

  test("reads the correct char when CJK precedes the cursor", () => {
    // "你好 x" — cursor after 你好 (width 4) must land on the space, not be shifted
    // by the width/UTF-16 mismatch.
    expect(charAfterCursor("你好 x", 4)).toBe(" ")
    // cursor after "你好 " (width 5) lands on "x"
    expect(charAfterCursor("你好 x", 5)).toBe("x")
  })

  test("returns undefined at end of input", () => {
    expect(charAfterCursor("你好", 4)).toBeUndefined()
  })
})
