import { describe, expect, test } from "bun:test"
import { decodeDataUrl } from "../../src/util/data-url"

describe("decodeDataUrl", () => {
  test("decodes base64 data URLs", () => {
    const body = '{\n  "ok": true\n}\n'
    const url = `data:text/plain;base64,${Buffer.from(body).toString("base64")}`
    expect(decodeDataUrl(url)).toBe(body)
  })

  test("decodes plain data URLs", () => {
    expect(decodeDataUrl("data:text/plain,hello%20world")).toBe("hello world")
  })

  test("decodes base64 data URLs whatever the case of the token", () => {
    // RFC 2397 makes `;base64` case-insensitive, and clients do send `;Base64`.
    const encoded = Buffer.from("hello").toString("base64")
    expect(decodeDataUrl(`data:text/plain;BASE64,${encoded}`)).toBe("hello")
    expect(decodeDataUrl(`data:text/plain;Base64,${encoded}`)).toBe("hello")
    expect(decodeDataUrl(`data:TEXT/PLAIN;base64,${encoded}`)).toBe("hello")
  })

  test("keeps the raw body when percent-decoding fails", () => {
    // `FilePart.url` is an unvalidated string, so a malformed escape must not
    // throw URIError out of decodeDataUrl and fail the whole turn.
    expect(decodeDataUrl("data:text/plain,coverage is 100%")).toBe("coverage is 100%")
    expect(decodeDataUrl("data:text/plain,a%zzb")).toBe("a%zzb")
    expect(decodeDataUrl("data:text/plain,50%25 done, 50% left")).toBe("50%25 done, 50% left")
  })

  test("still decodes valid escapes, including multi-byte ones", () => {
    expect(decodeDataUrl("data:text/plain,%E4%BD%A0%E5%A5%BD")).toBe("你好")
    expect(decodeDataUrl("data:text/plain,100%25")).toBe("100%")
  })

  test("returns empty string when there is no comma", () => {
    expect(decodeDataUrl("notadataurl")).toBe("")
  })
})
