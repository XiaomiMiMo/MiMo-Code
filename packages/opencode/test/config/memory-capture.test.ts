import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config"

describe("config.memory.capture", () => {
  test("absent when memory section is omitted", () => {
    expect(Config.Info.parse({}).memory?.capture).toBeUndefined()
  })

  test("absent when memory section is present but capture is unset", () => {
    expect(Config.Info.parse({ memory: {} }).memory?.capture).toBeUndefined()
  })

  test("accepts boolean value", () => {
    expect(Config.Info.parse({ memory: { capture: true } }).memory?.capture).toBe(true)
    expect(Config.Info.parse({ memory: { capture: false } }).memory?.capture).toBe(false)
  })

  test("rejects non-boolean values", () => {
    expect(() => Config.Info.parse({ memory: { capture: "off" } })).toThrow()
  })

  test("coexists with cc_index", () => {
    const cfg = Config.Info.parse({ memory: { capture: false, cc_index: true } })
    expect(cfg.memory?.capture).toBe(false)
    expect(cfg.memory?.cc_index).toBe(true)
  })
})
