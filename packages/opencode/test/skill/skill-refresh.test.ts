import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Skill } from "../../src/skill"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { withEnv } from "../lib/env"

withEnv({ MIMOCODE_DISABLE_COMPOSE_SKILLS: "true", MIMOCODE_DISABLE_BUILTIN_SKILLS: "true" })

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, CrossSpawnSpawner.defaultLayer))

function source(description: string, body: string) {
  return `---
name: refresh-test
description: ${description}
---

${body}
`
}

describe("skill refresh", () => {
  it.live("observes SKILL.md edits without an explicit reload", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const file = path.join(dir, ".mimocode", "skills", "refresh-test", "SKILL.md")
          yield* Effect.promise(() => Bun.write(file, source("Old description", "Old body")))

          const skill = yield* Skill.Service
          const before = yield* skill.get("refresh-test")
          expect(before?.description).toBe("Old description")
          expect(before?.content).toContain("Old body")

          yield* Effect.promise(() => Bun.write(file, source("Updated description", "Updated body with more text")))

          const after = yield* skill.get("refresh-test")
          expect(after?.description).toBe("Updated description")
          expect(after?.content).toContain("Updated body with more text")
        }),
      { git: true },
    ),
  )
})
