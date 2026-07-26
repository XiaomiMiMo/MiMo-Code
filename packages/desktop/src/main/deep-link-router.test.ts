import { describe, expect, test } from "bun:test"
import { parseMacDeepLink, type MacDeepLink } from "./deep-link-router"

describe("parseMacDeepLink", () => {
  test("parses session deep link", () => {
    const result = parseMacDeepLink("mimo://session/abc-123")
    expect(result).toEqual({ kind: "session", id: "abc-123" })
  })

  test("parses project deep link", () => {
    const result = parseMacDeepLink("mimo://project?path=/Users/test/project")
    expect(result).toEqual({ kind: "project", path: "/Users/test/project" })
  })

  test("parses prompt deep link", () => {
    const result = parseMacDeepLink("mimo://prompt?text=hello%20world")
    expect(result).toEqual({ kind: "prompt", text: "hello world" })
  })

  test("handles empty prompt text", () => {
    const result = parseMacDeepLink("mimo://prompt")
    expect(result).toEqual({ kind: "prompt", text: "" })
  })

  test("parses opencode:// scheme", () => {
    const result = parseMacDeepLink("opencode://session/sess-1")
    expect(result).toEqual({ kind: "session", id: "sess-1" })
  })

  test("returns unknown for non-mimo/non-opencode URL", () => {
    const result = parseMacDeepLink("https://example.com")
    expect(result).toEqual({ kind: "unknown", raw: "https://example.com" })
  })

  test("returns unknown for session URL without id", () => {
    const result = parseMacDeepLink("mimo://session/")
    expect(result).toEqual({ kind: "unknown", raw: "mimo://session/" })
  })

  test("returns unknown for project URL without path", () => {
    const result = parseMacDeepLink("mimo://project")
    expect(result).toEqual({ kind: "unknown", raw: "mimo://project" })
  })

  test("handles malformed URL gracefully", () => {
    // Pass a non-URL string that starts with opencode:// but has invalid format
    const result = parseMacDeepLink("opencode://%ZZinvalid")
    expect(result).toEqual({ kind: "unknown", raw: "opencode://%ZZinvalid" })
  })

  test("parses session id with slashes", () => {
    const result = parseMacDeepLink("mimo://session/org/repo/123")
    expect(result).toEqual({ kind: "session", id: "org/repo/123" })
  })
})
