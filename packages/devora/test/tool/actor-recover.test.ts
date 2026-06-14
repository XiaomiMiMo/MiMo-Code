import { describe, test, expect } from "bun:test"
import { recoverActorArgs } from "../../src/tool/actor"

describe("recoverActorArgs", () => {
  test("bare Task-prior fields → run operation", () => {
    expect(recoverActorArgs({ subagent_type: "explore", description: "d", prompt: "p" })).toEqual({
      operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p" },
    })
  })

  test("explicit action:spawn is honored", () => {
    expect(recoverActorArgs({ action: "spawn", subagent_type: "general", description: "d", prompt: "p" })).toEqual({
      operation: { action: "spawn", subagent_type: "general", description: "d", prompt: "p" },
    })
  })

  test("background:true infers spawn", () => {
    const r = recoverActorArgs({ subagent_type: "general", description: "d", prompt: "p", background: true }) as any
    expect(r.operation.action).toBe("spawn")
  })

  test("optional model/task_id/actor_id carried; junk dropped", () => {
    expect(
      recoverActorArgs({ subagent_type: "explore", description: "d", prompt: "p", model: "lite", task_id: "T4", junk: 1 }),
    ).toEqual({ operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p", model: "lite", task_id: "T4" } })
  })

  test("stringified operation envelope → parsed nested object", () => {
    expect(recoverActorArgs({ operation: '{"action":"run","subagent_type":"explore","description":"d","prompt":"p"}' })).toEqual({
      operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p" },
    })
  })

  test("already-nested operation → passthrough", () => {
    const op = { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p" } } as const
    expect(recoverActorArgs(op)).toEqual(op)
  })

  test("garbage / incomplete / non-object → undefined", () => {
    expect(recoverActorArgs({ foo: 1 })).toBeUndefined()
    expect(recoverActorArgs({ description: "d" })).toBeUndefined() // missing prompt+subagent_type
    expect(recoverActorArgs(null)).toBeUndefined()
    expect(recoverActorArgs("nope")).toBeUndefined()
  })

  test("array operation (object/string) is not mistaken for an envelope → undefined", () => {
    expect(recoverActorArgs({ operation: [1, 2, 3] })).toBeUndefined()
    expect(recoverActorArgs({ operation: "[1,2,3]" })).toBeUndefined()
  })
})
