import { afterEach, describe, expect, test } from "bun:test"
import ACTOR_DESCRIPTION from "../../src/tool/actor.txt"
import ACTOR_CHECKPOINT from "../../src/tool/actor.checkpoint.txt"
import MEMORY_DESCRIPTION from "../../src/tool/memory.txt"
import MEMORY_CHECKPOINT from "../../src/tool/memory.checkpoint.txt"
import TASK_DESCRIPTION from "../../src/tool/task.txt"
import { withCheckpointClause, withCheckpointDescription } from "../../src/tool/checkpoint-description"

const original = process.env.MIMOCODE_DISABLE_CHECKPOINT

function set(value?: string) {
  if (value === undefined) delete process.env.MIMOCODE_DISABLE_CHECKPOINT
  else process.env.MIMOCODE_DISABLE_CHECKPOINT = value
}

afterEach(() => set(original))

describe("tool schema checkpoint copy is composed, not always-on", () => {
  test("base actor/memory/task descriptions do not mention checkpoint", () => {
    expect(ACTOR_DESCRIPTION).not.toMatch(/checkpoint/i)
    expect(MEMORY_DESCRIPTION).not.toMatch(/checkpoint/i)
    expect(TASK_DESCRIPTION).not.toMatch(/checkpoint/i)
  })

  test("checkpoint fragments teach the disabled lifecycle", () => {
    expect(ACTOR_CHECKPOINT).toMatch(/checkpoint/i)
    expect(ACTOR_CHECKPOINT).not.toContain('context="state"')
    expect(ACTOR_CHECKPOINT).toContain("progress.md")
    expect(MEMORY_CHECKPOINT).toMatch(/checkpoint/i)
  })

  test("withCheckpointDescription omits the extra section when the flag is on", () => {
    set("true")
    expect(withCheckpointDescription(ACTOR_DESCRIPTION, ACTOR_CHECKPOINT)).toBe(ACTOR_DESCRIPTION)
    expect(withCheckpointDescription(MEMORY_DESCRIPTION, MEMORY_CHECKPOINT)).toBe(MEMORY_DESCRIPTION)
    expect(withCheckpointDescription(ACTOR_DESCRIPTION, ACTOR_CHECKPOINT)).not.toMatch(/checkpoint/i)
  })

  test("withCheckpointDescription appends the extra section when the flag is off", () => {
    set(undefined)
    const actor = withCheckpointDescription(ACTOR_DESCRIPTION, ACTOR_CHECKPOINT)
    const memory = withCheckpointDescription(MEMORY_DESCRIPTION, MEMORY_CHECKPOINT)
    expect(actor).toContain(ACTOR_DESCRIPTION.trim())
    expect(actor).toContain(ACTOR_CHECKPOINT.trim())
    expect(memory).toContain("Session checkpoints")
  })

  test("withCheckpointClause helper still gates optional copy on the flag", () => {
    const base = "(optional) example clause."
    const extra = "extra checkpoint sentence."
    set("true")
    expect(withCheckpointClause(base, extra)).toBe(base)
    expect(withCheckpointClause(base, extra)).not.toMatch(/checkpoint/i)
    set("false")
    expect(withCheckpointClause(base, extra)).toContain("checkpoint sentence")
  })

  test("actor tool descriptions do not advertise a model-facing context parameter", () => {
    expect(ACTOR_DESCRIPTION).not.toContain('context="full"')
    expect(ACTOR_DESCRIPTION).not.toContain('context="state"')
    expect(ACTOR_DESCRIPTION).not.toMatch(/context inheritance/i)
    expect(ACTOR_DESCRIPTION).not.toContain("## Context")
  })
})
