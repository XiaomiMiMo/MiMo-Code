import { describe, test, expect } from "bun:test"
import z from "zod"
import { validationErrorMessage } from "../../src/tool/tool"

describe("validationErrorMessage", () => {
  const result = z
    .object({ operation: z.object({ subagent_type: z.enum(["general", "explore"]) }) })
    .safeParse({ operation: { subagent_type: "foo" } })

  test("ZodError yields zod's prettified, path-annotated message (not generic boilerplate)", () => {
    expect(result.success).toBe(false)
    if (result.success) return
    const msg = validationErrorMessage("actor", result.error)
    expect(msg).toContain("actor") // names the tool
    expect(msg).toContain("subagent_type") // surfaces the offending field path
    expect(msg).toContain("general") // surfaces the expected values
    expect(msg).not.toContain("satisfies the expected schema") // dropped the filler
  })

  test("non-Zod error falls back to a generic actionable message", () => {
    const msg = validationErrorMessage("read", new Error("boom"))
    expect(msg).toContain("read")
    expect(msg.toLowerCase()).toContain("invalid arguments")
  })
})
