import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config"

describe("config.auto_worktree", () => {
  test("absent when the key is omitted (default off)", () => {
    expect(Config.Info.parse({}).auto_worktree).toBeUndefined()
  })

  test("accepts boolean value", () => {
    expect(Config.Info.parse({ auto_worktree: true }).auto_worktree).toBe(true)
    expect(Config.Info.parse({ auto_worktree: false }).auto_worktree).toBe(false)
  })

  test("rejects non-boolean values", () => {
    expect(() => Config.Info.parse({ auto_worktree: "yes" })).toThrow()
  })
})
