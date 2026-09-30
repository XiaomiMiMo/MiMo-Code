import { describe, expect, test } from "bun:test"
import { Info } from "../../src/agent/agent"

describe("Agent toolAllowlist", () => {
  test("Info schema accepts toolAllowlist", () => {
    const result = Info.safeParse({
      name: "test",
      mode: "subagent",
      permission: [],
      options: {},
      toolAllowlist: ["read", "grep"],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.toolAllowlist).toEqual(["read", "grep"])
    }
  })

  test("Info schema accepts empty toolAllowlist", () => {
    const result = Info.safeParse({
      name: "test",
      mode: "subagent",
      permission: [],
      options: {},
      toolAllowlist: [],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.toolAllowlist).toEqual([])
    }
  })

  test("Info schema allows undefined toolAllowlist (backward compatible)", () => {
    const result = Info.safeParse({
      name: "test",
      mode: "subagent",
      permission: [],
      options: {},
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.toolAllowlist).toBeUndefined()
    }
  })
})
