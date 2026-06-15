import { describe, test, expect } from "bun:test"
import { RecoverableError, isRecoverableError } from "../../src/tool/recoverable"

describe("RecoverableError", () => {
  test("is an Error subclass carrying message + name + marker", () => {
    const err = new RecoverableError("bad args")
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("bad args")
    expect(err.name).toBe("RecoverableError")
    expect(err.recoverable).toBe(true)
  })

  test("preserves cause", () => {
    const cause = new Error("zod")
    const err = new RecoverableError("bad args", { cause })
    expect(err.cause).toBe(cause)
  })
})

describe("isRecoverableError", () => {
  test("true for RecoverableError instances", () => {
    expect(isRecoverableError(new RecoverableError("x"))).toBe(true)
  })

  test("true for a structural recoverable marker", () => {
    expect(isRecoverableError({ recoverable: true })).toBe(true)
  })

  test("false for plain errors, falsy markers, and non-objects", () => {
    expect(isRecoverableError(new Error("x"))).toBe(false)
    expect(isRecoverableError({ recoverable: false })).toBe(false)
    expect(isRecoverableError("nope")).toBe(false)
    expect(isRecoverableError(undefined)).toBe(false)
    expect(isRecoverableError(null)).toBe(false)
  })
})
