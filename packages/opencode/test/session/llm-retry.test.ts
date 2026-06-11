import { describe, test, expect } from "bun:test"
import { isTransientCapacityError } from "../../src/session/llm"

describe("isTransientCapacityError", () => {
  test("returns false for plain Error", () => {
    expect(isTransientCapacityError(new Error("boom"))).toBe(false)
  })

  test("returns false for non-Error inputs", () => {
    expect(isTransientCapacityError(undefined)).toBe(false)
    expect(isTransientCapacityError(null)).toBe(false)
    expect(isTransientCapacityError("oops")).toBe(false)
    expect(isTransientCapacityError({ status: 503 })).toBe(false)
  })

  test("returns true for retryable HTTP statuses on a top-level Error", () => {
    for (const status of [429, 500, 502, 503, 504, 529]) {
      const err = Object.assign(new Error("server"), { status })
      expect(isTransientCapacityError(err)).toBe(true)
    }
  })

  test("returns true for retryable HTTP status nested under .response", () => {
    const err = Object.assign(new Error("nested"), { response: { status: 502 } })
    expect(isTransientCapacityError(err)).toBe(true)
  })

  test("returns false for non-retryable HTTP statuses", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const err = Object.assign(new Error("client"), { status })
      expect(isTransientCapacityError(err)).toBe(false)
    }
  })

  test("returns true for network error codes", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT"]) {
      const err = Object.assign(new Error("net"), { code })
      expect(isTransientCapacityError(err)).toBe(true)
    }
  })

  test("returns false for unrelated error codes", () => {
    const err = Object.assign(new Error("fs"), { code: "ENOENT" })
    expect(isTransientCapacityError(err)).toBe(false)
  })

  test("returns true for SSE read timeout (provider.ts wrapSSE)", () => {
    expect(isTransientCapacityError(new Error("SSE read timed out"))).toBe(true)
  })

  test("returns false for an unrelated 'timed out' message", () => {
    expect(isTransientCapacityError(new Error("connection timed out after 30s"))).toBe(false)
  })

  test("returns false for a user-initiated AbortError", () => {
    const err = new DOMException("user aborted", "AbortError")
    expect(isTransientCapacityError(err)).toBe(false)
  })
})
