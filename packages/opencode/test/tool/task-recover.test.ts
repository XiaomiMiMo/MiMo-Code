import { describe, test, expect } from "bun:test"
import { recoverTaskArgs } from "../../src/tool/task"

describe("recoverTaskArgs", () => {
  test("bare {summary} → create operation", () => {
    expect(recoverTaskArgs({ summary: "Implement auth" })).toEqual({
      operation: { action: "create", summary: "Implement auth" },
    })
  })

  test("bare {summary, parent_id} carries parent_id", () => {
    expect(recoverTaskArgs({ summary: "Lexer", parent_id: "T1" })).toEqual({
      operation: { action: "create", summary: "Lexer", parent_id: "T1" },
    })
  })

  test("stringified operation → parsed nested", () => {
    expect(recoverTaskArgs({ operation: '{"action":"list"}' })).toEqual({ operation: { action: "list" } })
  })

  test("already-nested operation → passthrough", () => {
    const op = { operation: { action: "get", id: "T1" } } as const
    expect(recoverTaskArgs(op)).toEqual(op)
  })

  test("ambiguous / non-object → undefined", () => {
    expect(recoverTaskArgs({ id: "T1" })).toBeUndefined() // id alone: get? start? done? — can't guess
    expect(recoverTaskArgs({ foo: 1 })).toBeUndefined()
    expect(recoverTaskArgs(null)).toBeUndefined()
  })

  test("array operation is not mistaken for an envelope → undefined", () => {
    expect(recoverTaskArgs({ operation: [1, 2] })).toBeUndefined()
    expect(recoverTaskArgs({ operation: "[1,2]" })).toBeUndefined()
  })
})
