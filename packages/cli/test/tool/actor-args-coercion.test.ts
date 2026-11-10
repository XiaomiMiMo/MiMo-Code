import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { coerceActorArguments } from "../../src/tool/actor-args"

const CORRECT = {
  operation: {
    action: "spawn",
    description: "inspect the bug",
    prompt: "look into it",
    subagent_type: "general",
  },
} as const

// Shape A: subagent_type hoisted to the root beside the envelope. Unrepaired it
// fails with `Unrecognized key: "subagent_type"` plus
// `Invalid option: expected one of "explore"|"general"`, so nothing spawns.
const TOP_LEVEL_SUBAGENT_TYPE = {
  operation: { action: "spawn", description: "inspect the bug", prompt: "look into it" },
  subagent_type: "general",
}

// Shape B: the whole envelope stringified, which fails with
// `Invalid input: expected object, received string`.
const STRINGIFIED_OPERATION = {
  operation: JSON.stringify({ action: "spawn", description: "inspect the bug", prompt: "look into it" }),
  subagent_type: "general",
}
const STRINGIFIED_OPERATION_RAW_NEWLINES = {
  operation:
    '{"action": "spawn", "description": "inspect the bug", "prompt": "look into it\n\nsecond line\tindented", "subagent_type": "general"}',
}

describe("coerceActorArguments", () => {
  test("moves a top-level subagent_type into the operation envelope", () => {
    expect(coerceActorArguments(TOP_LEVEL_SUBAGENT_TYPE)).toEqual({ operation: CORRECT.operation })
    expect(coerceActorArguments(TOP_LEVEL_SUBAGENT_TYPE)).not.toHaveProperty("subagent_type")
  })

  test("a nested subagent_type wins over a stray top-level one", () => {
    expect(
      coerceActorArguments({
        operation: { action: "spawn", description: "d", prompt: "p", subagent_type: "explore" },
        subagent_type: "general",
      }),
    ).toEqual({ operation: { action: "spawn", description: "d", prompt: "p", subagent_type: "explore" } })
  })

  test("parses a stringified operation envelope", () => {
    expect(coerceActorArguments(STRINGIFIED_OPERATION)).toEqual({ operation: CORRECT.operation })
  })

  test("parses a stringified envelope containing raw CR/LF/TAB", () => {
    expect(coerceActorArguments(STRINGIFIED_OPERATION_RAW_NEWLINES)).toEqual({
      operation: {
        action: "spawn",
        description: "inspect the bug",
        prompt: "look into it\n\nsecond line\tindented",
        subagent_type: "general",
      },
    })
  })

  test("wraps a flat bag and defaults the action to spawn", () => {
    expect(coerceActorArguments({ description: "d", prompt: "p", subagent_type: "general" })).toEqual({
      operation: { action: "spawn", description: "d", prompt: "p", subagent_type: "general" },
    })
    expect(coerceActorArguments({ action: "status", actor_id: "general-1" })).toEqual({
      operation: { action: "status", actor_id: "general-1" },
    })
  })

  test("valid input is returned unchanged (same reference)", () => {
    const valid = { operation: { action: "status" as const, actor_id: "general-1" } }
    expect(coerceActorArguments(valid)).toBe(valid)
    const correct: unknown = JSON.parse(JSON.stringify(CORRECT))
    expect(coerceActorArguments(correct)).toBe(correct)
  })

  test("an unparseable operation string is passed through untouched", () => {
    for (const value of [
      { operation: "{not json" },
      { operation: "{not json", subagent_type: "general" },
      { operation: "42" },
      { operation: "null" },
    ]) {
      expect(coerceActorArguments(value)).toEqual(value)
    }
  })

  test("never invents or rewrites a subagent_type", () => {
    expect(coerceActorArguments({ operation: { action: "spawn" }, subagent_type: "does-not-exist" })).toEqual({
      operation: { action: "spawn", subagent_type: "does-not-exist" },
    })
  })

  test("non-object input is returned unchanged", () => {
    for (const value of [undefined, null, "", "{}", 7, ["operation"]]) expect(coerceActorArguments(value)).toBe(value)
  })
})

// The behaviour-level seam test would have to build the Agent/Truncate service
// layer (Agent pulls Provider), which costs several seconds of module load in a
// suite that runs every tool test file under bun's default 5s per-test budget
// and is already at the edge. Assert the seam's invariants on the source
// instead: repair before validation, and the repaired value (never the raw one)
// reaches execute. Verified manually that a live version of this test fails with
// the two original zod errors when the wiring is removed.
describe("the coercion seam is wired", () => {
  const toolSource = readFileSync(path.join(import.meta.dir, "../../src/tool/tool.ts"), "utf8")
  const actorSource = readFileSync(path.join(import.meta.dir, "../../src/tool/actor.ts"), "utf8")

  test("wrap() repairs before validating and executes the repaired value", () => {
    expect(toolSource).toContain("coerceArgs ? coerceArgs(args) : args")
    expect(toolSource).toContain("toolInfo.parameters.parse(input)")
    expect(toolSource).toContain("execute(input, ctx)")
    expect(toolSource).not.toContain("parameters.parse(args)")
    expect(toolSource).not.toContain("execute(args, ctx)")
  })

  test("the actor tool installs the repair", () => {
    expect(actorSource).toContain("coerceArgs: coerceActorArguments")
  })
})
