import { describe, expect, it } from "bun:test"
import { parseReturnHeader } from "../../src/actor/return-header"

describe("parseReturnHeader", () => {
  it("parses each status value", () => {
    for (const s of ["success", "partial", "failed", "blocked"] as const) {
      expect(parseReturnHeader(`**Status**: ${s}\n**Summary**: x`).status).toBe(s)
    }
  })

  it("parses the summary, trimming whitespace", () => {
    const r = parseReturnHeader("**Status**: success\n**Summary**:   did the thing   ")
    expect(r.summary).toBe("did the thing")
  })

  it("keeps colons inside the summary", () => {
    const r = parseReturnHeader("**Status**: partial\n**Summary**: ratio is 3:1 here")
    expect(r.summary).toBe("ratio is 3:1 here")
  })

  it("tolerates leading whitespace/case and a preamble before Summary", () => {
    const r = parseReturnHeader("  **status**: BLOCKED\nsome text\n**summary**: waiting on review")
    expect(r.status).toBe("blocked")
    expect(r.summary).toBe("waiting on review")
  })

  it("returns {} for missing/empty/malformed input", () => {
    expect(parseReturnHeader(undefined)).toEqual({})
    expect(parseReturnHeader("")).toEqual({})
    expect(parseReturnHeader("just some prose, no header")).toEqual({})
    expect(parseReturnHeader("**Status**: done").status).toBeUndefined()
  })

  it("ignores a Status that is not on the first content line only if absent", () => {
    // Status anywhere with `m` flag still matches; documents current behavior.
    const r = parseReturnHeader("intro\n**Status**: success\n**Summary**: ok")
    expect(r.status).toBe("success")
    expect(r.summary).toBe("ok")
  })
})
