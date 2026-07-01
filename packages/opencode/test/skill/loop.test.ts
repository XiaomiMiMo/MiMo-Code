import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Disable compose bundle to keep the skill universe small for this test; keep
// the builtin bundle ON so the /loop skill is discoverable.
process.env.MIMOCODE_DISABLE_COMPOSE_SKILLS = "true"
process.env.MIMOCODE_DISABLE_EXTERNAL_SKILLS = "true"
delete process.env.MIMOCODE_DISABLE_BUILTIN_SKILLS

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("loop skill", () => {
  it.live("registers /loop from the builtin bundle", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const list = yield* skill.all()

          const loop = list.find((s) => s.name === "loop")
          expect(loop).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("/loop skill teaches three-rule parsing, interval→cron table, immediate-execute, and autonomous sentinel", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const loop = yield* skill.get("loop")
          expect(loop).toBeDefined()

          const body = loop!.content

          // Three-rule parsing priority (leading token, trailing `every`, default).
          expect(body).toContain("^\\d+[smhd]$")
          expect(body.toLowerCase()).toContain("every")
          expect(body).toContain("10m")

          // Interval → cron lookup table.
          expect(body).toContain("*/N * * * *")
          expect(body).toContain("0 */N * * *")
          expect(body).toContain("0 0 */N * *")

          // Concrete worked example proving 5m → */5.
          expect(body).toContain("*/5 * * * *")

          // Autonomous sentinel.
          expect(body).toContain("<<autonomous-loop>>")

          // Immediate first-execute rule.
          expect(body.toLowerCase()).toContain("immediately")

          // Instructs the model to call the cron tool's schedule verb — but
          // does NOT hardcode a JSON call form (invocation style is per-session).
          expect(body.toLowerCase()).toContain("cron")
          expect(body.toLowerCase()).toContain("schedule")
        }),
      { git: true },
    ),
  )
})
