import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

afterEach(() => {
  process.env.MIMOCODE_RL_MODE = "false"
})

describe("MIMOCODE_RL_MODE", () => {
  test("defaults true and parses explicit true/false values", () => {
    delete process.env.MIMOCODE_RL_MODE
    expect(Flag.MIMOCODE_RL_MODE).toBe(true)
    process.env.MIMOCODE_RL_MODE = "true"
    expect(Flag.MIMOCODE_RL_MODE).toBe(true)
    process.env.MIMOCODE_RL_MODE = "1"
    expect(Flag.MIMOCODE_RL_MODE).toBe(true)
    process.env.MIMOCODE_RL_MODE = "false"
    expect(Flag.MIMOCODE_RL_MODE).toBe(false)
    process.env.MIMOCODE_RL_MODE = "0"
    expect(Flag.MIMOCODE_RL_MODE).toBe(false)
  })
})
