import { describe, expect, test } from "bun:test"
import { detectTrigger } from "../../../../src/cli/cmd/tui/component/prompt/autocomplete-detect"

// cursorWidth is the editor's display-width cursor offset (CJK = 2 columns).
// detectTrigger inspects the plainText and returns the trigger kind plus the
// trigger's position expressed in the SAME width coordinate (matching store.index),
// or undefined when nothing should open.
describe("detectTrigger", () => {
  test("returns undefined at start of input", () => {
    expect(detectTrigger("", 0)).toBeUndefined()
    expect(detectTrigger("@foo", 0)).toBeUndefined()
  })

  test("detects a leading slash command", () => {
    expect(detectTrigger("/hel", 4)).toEqual({ kind: "/", index: 0 })
  })

  test("detects @ trigger in pure ascii", () => {
    // "hi @fo" cursor at end (width 6)
    expect(detectTrigger("hi @fo", 6)).toEqual({ kind: "@", index: 3 })
  })

  test("detects $ trigger in pure ascii", () => {
    expect(detectTrigger("run $ag", 7)).toEqual({ kind: "$", index: 4 })
  })

  test("returns width-based index when CJK precedes the trigger", () => {
    // "你好 @fo" — 你好 width 4, space width 1, so @ sits at width index 5 (string index 3)
    // cursor at end: width = 5 + 3 = 8
    expect(detectTrigger("你好 @fo", 8)).toEqual({ kind: "@", index: 5 })
  })

  test("returns width-based index for a $ trigger preceded by CJK", () => {
    // "你好 $ag" — same geometry as the @ case but for the agent trigger.
    expect(detectTrigger("你好 $ag", 8)).toEqual({ kind: "$", index: 5 })
  })

  test("does not over-read past the cursor when CJK follows the trigger", () => {
    // "你好 @x尾巴", cursor right after "@x": 你好(4)+space(1)+@x(2) = width 7 (string index 5).
    // There is no whitespace between @ and the cursor, so it must still trigger,
    // and must NOT be fooled by the trailing "尾巴" after the cursor.
    expect(detectTrigger("你好 @x尾巴", 7)).toEqual({ kind: "@", index: 5 })
  })

  test("does not trigger when whitespace sits between trigger and cursor", () => {
    // "你 @ x" — @ is preceded by a space (valid start) but a space sits between @ and the cursor.
    // 你(2)+space(1)+@(1)+space(1)+x(1) = width 6
    expect(detectTrigger("你 @ x", 6)).toBeUndefined()
  })

  test("does not trigger when char before @ is non-whitespace", () => {
    // "a@fo" — '@' is glued to 'a', not a fresh mention
    expect(detectTrigger("a@fo", 4)).toBeUndefined()
  })
})
