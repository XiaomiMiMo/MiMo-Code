import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Skill } from "../../src/skill"
import { builtinSkillRoot } from "../../src/skill/builtin/extract"
import { loadComposeBundle } from "../../src/skill/compose/bundle.macro"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { withEnv } from "../lib/env"

withEnv({
  MIMOCODE_DISABLE_AGENTS_SKILLS: "true",
  MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS: undefined,
  MIMOCODE_ENABLE_CODEX_SKILLS: undefined,
  MIMOCODE_ENABLE_OPENCODE_SKILLS: undefined,
  MIMOCODE_DISABLE_BUILTIN_SKILLS: undefined,
  MIMOCODE_DISABLE_COMPOSE_SKILLS: undefined,
})

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("bundled skill discovery", () => {
  it.live("registers top-level builtins without exposing their workflows or affecting compose skills", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const retired = path.join(builtinSkillRoot(), "evolve", "SKILL.md")
          yield* Effect.promise(() =>
            Bun.write(retired, "---\nname: evolve\ndescription: Retired builtin fixture\n---\nRetired skill"),
          )
          const skill = yield* Skill.Service
          const list = yield* skill.all()
          const names = new Set(list.map((item) => item.name))

          expect(names.has("data-analytics")).toBe(true)
          expect(names.has("grok-build")).toBe(true)
          expect(names.has("product-design")).toBe(true)
          expect(names.has("sales")).toBe(true)
          expect(names.has("drive-mimo")).toBe(false)
          expect(names.has("evolve")).toBe(false)
          expect(yield* Effect.promise(() => Bun.file(retired).exists())).toBe(false)
          expect(
            list.filter((item) => item.bundled && item.location.includes(`${path.sep}workflows${path.sep}`)),
          ).toEqual([])

          const dataAnalytics = list.find((item) => item.name === "data-analytics")
          expect(dataAnalytics).toBeDefined()
          expect(
            yield* Effect.promise(() =>
              Bun.file(
                path.join(
                  path.dirname(dataAnalytics!.location),
                  "workflows",
                  "analyze-data-quality",
                  "SKILL.md",
                ),
              ).exists(),
            ),
          ).toBe(true)

          expect(
            list
              .filter((item) => item.name.startsWith("compose:"))
              .map((item) => item.name)
              .toSorted(),
          ).toEqual(Object.keys(loadComposeBundle()).map((name) => `compose:${name}`).toSorted())
        }),
      { git: true },
    ),
  )
})
