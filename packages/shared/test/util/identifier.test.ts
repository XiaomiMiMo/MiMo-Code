import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/util/identifier"

const WRAP_MS = 2 ** 36
const WRAP_26 = 26 * WRAP_MS

describe("Identifier", () => {
  test("payload is still 26 chars", () => {
    expect(Identifier.ascending().length).toBe(26)
    expect(Identifier.descending().length).toBe(26)
  })

  test("ascending v2 sorts after a max v1 id", () => {
    const next = Identifier.ascending()
    expect(next[0]).toBe("g")
    expect("f".repeat(12) + "0".repeat(14) < next).toBe(true)
  })

  test("descending v2 sorts before a min v1 id", () => {
    const next = Identifier.descending()
    expect(next[0]).toBe("-")
    expect(next < "0".repeat(26)).toBe(true)
  })

  test("ascending ids stay ordered across the old 48-bit wrap", () => {
    const before = Identifier.create(false, WRAP_26 - 1)
    const after = Identifier.create(false, WRAP_26)
    expect(before < after).toBe(true)
  })
})
