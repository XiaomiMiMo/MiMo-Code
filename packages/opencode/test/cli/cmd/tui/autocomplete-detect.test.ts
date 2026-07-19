import { describe, expect, test } from "bun:test"
import { detectTrigger, exactSubmitOption } from "../../../../src/cli/cmd/tui/component/prompt/autocomplete-detect"
import { tokenEndWidth } from "../../../../src/cli/cmd/tui/component/prompt/offset"

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

  // Mid-message "/" skill trigger tests
  test("detects mid-message / with at least one char typed", () => {
    // "hello /ef" — / preceded by space, "ef" after it, cursor at end (width 9)
    expect(detectTrigger("hello /ef", 9)).toEqual({ kind: "/", index: 6 })
  })

  test("does not trigger lone / mid-message (needs at least one char)", () => {
    // "hello /" — just the slash, no chars after → should NOT open
    expect(detectTrigger("hello /", 7)).toBeUndefined()
  })

  test("does not trigger / mid-message when preceded by non-whitespace", () => {
    // "https://x.com/api" — slashes not preceded by whitespace
    expect(detectTrigger("https://x.com/api", 17)).toBeUndefined()
  })

  test("detects mid-message / with CJK before trigger", () => {
    // "你好 /ef" — 你好(4) + space(1) + /ef(3) = cursor width 8, / at width 5
    expect(detectTrigger("你好 /ef", 8)).toEqual({ kind: "/", index: 5 })
  })

  test("position-0 / with whitespace returns undefined (not single-command)", () => {
    // "/init foo" with cursor at end — has whitespace before cursor, first check fails
    // mid-message check: last / is at 0, before is undefined (idx===0), between="/init foo" has space → no
    expect(detectTrigger("/init foo", 9)).toBeUndefined()
  })

  test("position-0 / without whitespace is detected as position-0 trigger", () => {
    // "/models1234" cursor in middle (width 8) — no whitespace before cursor
    expect(detectTrigger("/models1234", 8)).toEqual({ kind: "/", index: 0 })
  })

  test("prefers later trigger when multiple exist", () => {
    // "hello /effect /fro" — should detect the LAST / (at position 14)
    expect(detectTrigger("hello /effect /fro", 18)).toEqual({ kind: "/", index: 14 })
  })
})

describe("exactSubmitOption", () => {
  const options = [
    { display: "/frontend-design  " },
    { display: "/前端设计  ", submitOnSelect: true },
  ]

  test("returns an exact Chinese skill alias for immediate submission", () => {
    expect(exactSubmitOption("/", "前端设计", options)).toBe(options[1])
  })

  test("does not immediately submit partial aliases or canonical commands", () => {
    expect(exactSubmitOption("/", "前端", options)).toBeUndefined()
    expect(exactSubmitOption("/", "frontend-design", options)).toBeUndefined()
  })

  test("does not submit from non-slash autocomplete", () => {
    expect(exactSubmitOption("@", "前端设计", options)).toBeUndefined()
  })
})

describe("tokenEndWidth", () => {
  test("finds end at whitespace boundary", () => {
    // "/models 1234" — token starts at 0, ends at space (width 7)
    expect(tokenEndWidth("/models 1234", 0)).toBe(7)
  })

  test("finds end at end of text when no trailing space", () => {
    // "hello /effect" — token starts at 6, ends at 13 (end of text)
    expect(tokenEndWidth("hello /effect", 6)).toBe(13)
  })

  test("handles mid-text token with content after space", () => {
    // "hello /effect world" — token at 6, ends at space before "world" (width 13)
    expect(tokenEndWidth("hello /effect world", 6)).toBe(13)
  })

  test("handles CJK in token", () => {
    // "你好 /技能 end" — / at width 5 (string index 3), token is "/技能" (width 5+1+2+2=5 from start)
    // / width 1, 技 width 2, 能 width 2 → token end at width 5+1+2+2 = 10
    expect(tokenEndWidth("你好 /技能 end", 5)).toBe(10)
  })

  test("handles token starting at position 0", () => {
    // "/init" — whole text is the token
    expect(tokenEndWidth("/init", 0)).toBe(5)
  })

  test("handles second token after first", () => {
    // "/effect /frontend" — second token starts at 8
    expect(tokenEndWidth("/effect /frontend", 8)).toBe(17)
  })
})
