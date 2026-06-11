import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import z from "zod"
import type { Tool } from "../../src/tool"

describe("Tool.Def shell field shape", () => {
  test("Def accepts a shell field whose parse returns Effect of args[]", () => {
    const params = z.object({ action: z.string(), id: z.string().optional() })
    const def: Tool.Def<typeof params> = {
      id: "synthetic",
      description: "json",
      parameters: params,
      execute: () => Effect.succeed({ title: "", output: "", metadata: {} }),
      shell: {
        description: "shell",
        parse: (_script) =>
          Effect.succeed([{ action: "noop" } as z.infer<typeof params>]),
      },
    }
    expect(def.shell?.description).toBe("shell")
    expect(typeof def.shell?.parse).toBe("function")
  })
})
