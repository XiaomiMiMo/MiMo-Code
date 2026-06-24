import { describe, expect, test } from "bun:test"
import { stringIndexToWidth, widthToStringIndex } from "../../../../src/cli/cmd/tui/component/prompt/offset"

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
})
