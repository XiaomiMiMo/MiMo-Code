import { expect, test } from "bun:test"
import { cleanDataUrls, detail, page } from "../../src/history/media"

test("linear cleaning preserves ordinary text and adjacent words", () => {
  const payload = "ABcd09+/".repeat(1024 * 1024)
  const raw = `before data:image/png;base64,${payload} after`
  expect(cleanDataUrls(raw)).toBe("before [media image/png; omitted; use history get] after")
  expect(cleanDataUrls(payload)).toBe(payload)
  expect(cleanDataUrls("data:ordinary text remains")).toBe("data:ordinary text remains")
  expect(cleanDataUrls("DATA:image/png;base64,YQ==after")).toBe("[media image/png; omitted; use history get]after")
  expect(cleanDataUrls("data:;charset=utf-8;base64,YQ== text")).toBe(
    "[media text/plain; omitted; use history get] text",
  )
  expect(cleanDataUrls(`data:${"data:bad;".repeat(10000)}`)).toBe(`data:${"data:bad;".repeat(10000)}`)
  expect(cleanDataUrls("data:image/png,ordinary-percent%20text")).toBe("data:image/png,ordinary-percent%20text")
})

test("data URL boundaries, padding and block edges preserve source attachments", () => {
  for (const payload of ["YQ==", "YWI=", "YWJj", "YQ", "YWI", "YWJj".repeat(16385)]) {
    const url = `data:image/png;base64,${payload}`
    for (const boundary of ["'", '"', " ", "中", "_", "-", ":", "[", "{"]) {
      const result = detail({ type: "text", text: `${url}${boundary}after` })
      expect(result.attachments[0]?.url).toBe(url)
      expect(result.text).toEndWith(`${boundary}after`)
    }
  }
  for (const payload of ["", "A", "YQ=", "YWJj=", "YQ===", "YR==", "YWJ="]) {
    const text = `data:image/png;base64,${payload} text`
    expect(cleanDataUrls(text)).toBe(text)
  }
})

test("summary omits locators while get resolves JSON keys and values distinctly", () => {
  const a = "data:image/png;base64,YWJj"
  const b = "data:image/png;base64,ZGVm"
  const raw = { type: "tool", state: { input: { [a]: b } } }
  expect(cleanDataUrls(JSON.stringify(raw.state.input))).not.toContain("attachment=")
  expect(detail(raw, false).text).not.toContain("attachment=")
  const result = detail(raw)
  const input = JSON.parse(result.text.split("\ninput: ")[1].split("\noutput: ")[0])
  const key = Object.keys(input)[0]
  for (const [text, url] of [
    [key, a],
    [input[key], b],
  ]) {
    const id = text.match(/attachment=(inline:\d+)/)?.[1]
    expect(result.attachments.find((item) => item.id === id)?.url).toBe(url)
  }
})

test("stable native and inline attachment locators without mutation", () => {
  const raw = {
    type: "tool",
    tool: "image",
    state: {
      input: { image: "data:image/png;base64,YWJj" },
      output: "done",
      attachments: [{ mime: "image/png", url: "https://example.com/a.png" }],
    },
  }
  const before = JSON.stringify(raw)
  expect(detail(raw).attachments.map((x) => x.id)).toEqual(["inline:0", "tool:0"])
  expect(detail(raw)).toEqual(detail(raw))
  expect(JSON.stringify(raw)).toBe(before)
})

test("UTF16 pages preserve all CJK and emoji within byte budget", () => {
  const text = "中文😀".repeat(10000)
  let offset = 0
  let restored = ""
  while (offset < text.length) {
    const result = page(text, offset, 8000, 12000)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(12000)
    expect(result.text.endsWith("\ud83d")).toBe(false)
    restored += result.text
    offset = result.next_offset
  }
  expect(restored).toBe(text)
  expect(() => page(text, 3, 1)).toThrow()
  expect(() => page(text, -1, 1)).toThrow()
  expect(() => page(text, 0, 0)).toThrow()
})
