import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { SystemPrompt } from "../../src/session/system"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { withEnv } from "../lib/env"

// SystemPrompt.skillNames backs the ENGINE-1 capability receipt's skills[] half.
// The invariant under test: it returns exactly what the MODEL can reach —
// Skill.modelInvocable (permission-filtered AND disable_model_invocation-filtered)
// — never the broader `available`/`all` sets. Getting this wrong makes the
// receipt over-report skills the model could not actually call.
withEnv({ MIMOCODE_DISABLE_BUILTIN_SKILLS: "true", MIMOCODE_DISABLE_COMPOSE_SKILLS: "true" })

const it = testEffect(Layer.mergeAll(SystemPrompt.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer))

function writeSkill(dir: string, name: string, extraFrontmatter?: string) {
  return Effect.promise(() =>
    Bun.write(
      path.join(dir, ".mimocode", "skill", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} used by skillNames tests.\n${extraFrontmatter ? `${extraFrontmatter}\n` : ""}---\n\n# ${name}\n\nbody\n`,
    ),
  )
}

describe("SystemPrompt.skillNames (ENGINE-1 receipt skills half)", () => {
  // [TP-ER-R6-04] receipt skills[] excludes disable-model-invocation skills
  it.live("excludes skills marked disable-model-invocation", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "reachable-skill")
          yield* writeSkill(dir, "hidden-skill", "disable-model-invocation: true")

          const agents = yield* Agent.Service
          const sys = yield* SystemPrompt.Service
          const agent = yield* agents.get(yield* agents.defaultAgent())

          const names = yield* sys.skillNames(agent)
          expect(names).toContain("reachable-skill")
          expect(names).not.toContain("hidden-skill")
        }),
      { git: true },
    ),
  )

  // [TP-ER-R6-04] skill-permission-denied agent → receipt skills[] empty
  it.live("returns empty when the skill tool is permission-disabled for the agent", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "some-skill")

          const agents = yield* Agent.Service
          const sys = yield* SystemPrompt.Service
          const base = yield* agents.get(yield* agents.defaultAgent())
          const denied: Agent.Info = {
            ...base,
            permission: [{ permission: "skill", pattern: "*", action: "deny" }],
          }

          const names = yield* sys.skillNames(denied)
          expect(names).toEqual([])
        }),
      { git: true },
    ),
  )
})
