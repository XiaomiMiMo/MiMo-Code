import { describe, expect, test } from "bun:test"
import type { PromptInfo } from "../../../../src/cli/cmd/tui/component/prompt/history"
import { assign, expandPlaceholders, strip } from "../../../../src/cli/cmd/tui/component/prompt/part"

describe("prompt part", () => {
  test("strip removes persisted ids from reused file parts", () => {
    const part = {
      id: "prt_old",
      sessionID: "ses_old",
      messageID: "msg_old",
      type: "file" as const,
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    }

    expect(strip(part)).toEqual({
      type: "file",
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    })
  })

  test("assign overwrites stale runtime ids", () => {
    const part = {
      id: "prt_old",
      sessionID: "ses_old",
      messageID: "msg_old",
      type: "file" as const,
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    } as PromptInfo["parts"][number]

    const next = assign(part)

    expect(next.id).not.toBe("prt_old")
    expect(next.id.startsWith("prt_")).toBe(true)
    expect(next).toMatchObject({
      type: "file",
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    })
  })
})

describe("expandPlaceholders", () => {
  // Editor extmark offsets are display-WIDTH based (CJK = 2 columns), while the
  // plain text is a JS UTF-16 string (CJK = 1 unit). expandPlaceholders must
  // bridge the two coordinate systems.

  test("expands a single ascii placeholder", () => {
    const result = expandPlaceholders("[Pasted ~3 lines] ", [
      { start: 0, end: "[Pasted ~3 lines]".length, text: "line1\nline2\nline3" },
    ])
    expect(result).toBe("line1\nline2\nline3 ")
  })

  test("does not leave residue or swallow content when preceded by CJK", () => {
    // User typed "你好" (width 4, but string index 2) then pasted.
    // plainText shown in editor: "你好[Pasted ~3 lines] "
    // extmark.start is width-based = 4, extmark.end = 4 + 17 = 21
    const result = expandPlaceholders("你好[Pasted ~3 lines] ", [
      { start: 4, end: 4 + "[Pasted ~3 lines]".length, text: "line1\nline2\nline3" },
    ])
    expect(result).toBe("你好line1\nline2\nline3 ")
  })

  test("handles multiple placeholders interleaved with CJK", () => {
    const v1 = "[Pasted ~3 lines]"
    const v2 = "[Pasted ~2 lines]"
    // plainText: "你好" + v1 + " " + "世界" + v2 + " " + "末"
    // widths: 你好=4 -> v1 start 4, end 4+17=21; after v1+space width=18 => 22; 世界=4 => 26; v2 start 26 end 43
    const plain = `你好${v1} 世界${v2} 末`
    const result = expandPlaceholders(plain, [
      { start: 4, end: 4 + v1.length, text: "AAA" },
      { start: 26, end: 26 + v2.length, text: "BBB" },
    ])
    expect(result).toBe("你好AAA 世界BBB 末")
  })

  test("expands a placeholder that sits on its own line after CJK", () => {
    const v = "[Pasted ~3 lines]"
    // User typed CJK on line 1, pasted on line 2, typed CJK on line 3:
    //   "你好\n" + v + " " + "\n世界"
    // Editor offsets count "\n" as width 1: 你好=4, \n=5, so the placeholder starts at width 5.
    const plain = `你好\n${v} \n世界`
    const result = expandPlaceholders(plain, [{ start: 5, end: 5 + v.length, text: "CONTENT" }])
    expect(result).toBe("你好\nCONTENT \n世界")
  })

  test("returns input unchanged when there are no placeholders", () => {
    expect(expandPlaceholders("你好世界", [])).toBe("你好世界")
  })
})
