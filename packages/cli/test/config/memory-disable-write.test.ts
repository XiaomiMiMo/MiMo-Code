import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config"
import { isMemoryWriteEnabled } from "../../src/memory/write-gate"

describe("config.memory.disable_write", () => {
  test("absent when memory section is omitted", () => {
    expect(Config.Info.parse({}).memory?.disable_write).toBeUndefined()
  })

  test("absent when memory section is present but disable_write is unset", () => {
    expect(Config.Info.parse({ memory: {} }).memory?.disable_write).toBeUndefined()
  })

  test("accepts boolean value", () => {
    expect(Config.Info.parse({ memory: { disable_write: true } }).memory?.disable_write).toBe(true)
    expect(Config.Info.parse({ memory: { disable_write: false } }).memory?.disable_write).toBe(false)
  })

  test("rejects non-boolean values", () => {
    expect(() => Config.Info.parse({ memory: { disable_write: "yes" } })).toThrow()
  })

  test("coexists with cc_index", () => {
    const cfg = Config.Info.parse({ memory: { disable_write: true, cc_index: true } })
    expect(cfg.memory?.disable_write).toBe(true)
    expect(cfg.memory?.cc_index).toBe(true)
  })
})

// The accessor is the only place allowed to know the field name, its negative
// polarity, and its default. These pin all three so a future rename or a
// degradation of `!== true` into a truthy check fails loudly here.
describe("isMemoryWriteEnabled", () => {
  test("undefined config → writing enabled", () => {
    expect(isMemoryWriteEnabled(undefined)).toBe(true)
  })

  test("no memory section → writing enabled (backward compatible default)", () => {
    expect(isMemoryWriteEnabled(Config.Info.parse({}))).toBe(true)
  })

  test("memory section without the field → writing enabled", () => {
    expect(isMemoryWriteEnabled(Config.Info.parse({ memory: {} }))).toBe(true)
  })

  test("disable_write: false → writing enabled", () => {
    expect(isMemoryWriteEnabled(Config.Info.parse({ memory: { disable_write: false } }))).toBe(true)
  })

  test("disable_write: true → writing disabled", () => {
    expect(isMemoryWriteEnabled(Config.Info.parse({ memory: { disable_write: true } }))).toBe(false)
  })

  test("only a literal true disables — a non-boolean must not silently disable", () => {
    // Config parsing rejects this shape; the accessor is nonetheless the last
    // line of defense for callers holding an unvalidated (SDK-typed) object.
    expect(isMemoryWriteEnabled({ memory: { disable_write: "true" as unknown as boolean } })).toBe(true)
    expect(isMemoryWriteEnabled({ memory: { disable_write: 1 as unknown as boolean } })).toBe(true)
  })
})
