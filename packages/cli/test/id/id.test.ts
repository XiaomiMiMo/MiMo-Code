import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

const WRAP_MS = 2 ** 36
const WRAP_26 = 26 * WRAP_MS

function v1(prefix: string, hex12: string) {
  return `${prefix}_${hex12}${"0".repeat(14)}`
}

function v1At(prefix: string, ts: number) {
  const hex = ((BigInt(ts) * 0x1000n + 1n) & 0xffffffffffffn).toString(16).padStart(12, "0")
  return `${prefix}_${hex}${"0".repeat(14)}`
}

describe("Identifier", () => {
  test("payload after prefix is still 26 chars", () => {
    const id = Identifier.ascending("message")
    expect(id.startsWith("msg_")).toBe(true)
    expect(id.slice(4).length).toBe(26)
  })

  test("ascending v2 starts with g so it sorts after every v1 id", () => {
    const next = Identifier.ascending("message")
    expect(next[4]).toBe("g")
    expect(v1("msg", "ffffffffffff") < next).toBe(true)
    expect(v1("msg", "000000000000") < next).toBe(true)
    expect("msg_fd708d21e001JXYNUE1Jba3VEW" < next).toBe(true)
  })

  test("descending v2 starts with - so it sorts before every v1 id", () => {
    const next = Identifier.descending("message")
    expect(next[4]).toBe("-")
    expect(next < v1("msg", "000000000000")).toBe(true)
    expect(next < v1("msg", "ffffffffffff")).toBe(true)
  })

  test("session IDs keep a hexadecimal payload without a sort marker", () => {
    const next = Identifier.descending("session")
    expect(next).toMatch(/^ses_[0-9a-f]{16}[0-9A-Za-z]{10}$/)
  })

  test("ascending ids stay ordered across the old 48-bit wrap", () => {
    const before = Identifier.create("msg", "ascending", WRAP_26 - 1)
    const after = Identifier.create("msg", "ascending", WRAP_26)
    expect(before < after).toBe(true)
    expect(Identifier.timestamp(before)).toBe(WRAP_26 - 1)
    expect(Identifier.timestamp(after)).toBe(WRAP_26)
  })

  test("same-millisecond ascending ids are ordered by counter", () => {
    const a = Identifier.create("msg", "ascending", 1_700_000_000_000)
    const b = Identifier.create("msg", "ascending", 1_700_000_000_000)
    expect(a < b).toBe(true)
    expect(Identifier.timestamp(a)).toBe(1_700_000_000_000)
    expect(Identifier.timestamp(b)).toBe(1_700_000_000_000)
  })

  test("timestamp() unwraps a v1 id onto the current 2^36 cycle", () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000
    expect(Identifier.timestamp(v1At("msg", threeDaysAgo))).toBe(threeDaysAgo)
  })

  test("timestamp() keeps a pre-wrap v1 id in the previous cycle", () => {
    expect(Identifier.timestamp(v1At("msg", WRAP_26 - 1000), WRAP_26 + 1000)).toBe(WRAP_26 - 1000)
  })

  test("a 3-day-old v1 id is newer than a 7-day v2 cutoff", () => {
    const now = Date.now()
    const cutoff = Identifier.timestamp(Identifier.create("tool", "ascending", now - 7 * 24 * 60 * 60 * 1000), now)
    expect(Identifier.timestamp(v1At("tool", now - 3 * 24 * 60 * 60 * 1000), now)).toBeGreaterThanOrEqual(cutoff)
  })

  test("schema accepts both v1 and v2", () => {
    const schema = Identifier.schema("message")
    expect(schema.safeParse("msg_f4c12734b001QCMNgJEWL8E2J3").success).toBe(true)
    expect(schema.safeParse(Identifier.ascending("message")).success).toBe(true)
    expect(schema.safeParse("prt_g00").success).toBe(false)
  })
})
