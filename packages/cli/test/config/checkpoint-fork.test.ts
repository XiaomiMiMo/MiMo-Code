import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config"

describe("config.checkpoint.fork", () => {
  test("absent when checkpoint section is omitted", () => {
    expect(Config.Info.parse({}).checkpoint?.fork).toBeUndefined()
  })

  test("absent when checkpoint section is present but fork is unset", () => {
    expect(Config.Info.parse({ checkpoint: {} }).checkpoint?.fork).toBeUndefined()
  })

  test("accepts boolean value", () => {
    expect(Config.Info.parse({ checkpoint: { fork: true } }).checkpoint?.fork).toBe(true)
    expect(Config.Info.parse({ checkpoint: { fork: false } }).checkpoint?.fork).toBe(false)
  })

  test("rejects non-boolean values", () => {
    expect(() => Config.Info.parse({ checkpoint: { fork: "yes" } })).toThrow()
  })
})
