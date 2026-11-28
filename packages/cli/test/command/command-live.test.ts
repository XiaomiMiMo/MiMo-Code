import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Command } from "../../src/command"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { withEnv } from "../lib/env"

withEnv({ MIMOCODE_DISABLE_BUILTIN_SKILLS: "true" })

const it = testEffect(Layer.mergeAll(Command.defaultLayer, CrossSpawnSpawner.defaultLayer))

const writeSkill = (dir: string, name: string) =>
  Effect.promise(() =>
    Bun.write(
      path.join(dir, ".mimocode", "skill", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} for live command tests.\n---\n\n# ${name}\n`,
    ),
  )

describe("command list", () => {
  // [skill-catalog-live T5] Slash completion lists skills while an MCP server is
  // still connecting (a stdio server that never answers initialize), and picks
  // up a skill created afterwards without a restart.
  it.live("lists live skills without waiting for MCP servers to settle", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "first-skill")
          const command = yield* Command.Service

          const names = command.list().pipe(
            Effect.timeout("5 seconds"),
            Effect.map((list) => list.filter((item) => item.source === "skill").map((item) => item.name).toSorted()),
          )
          expect(yield* names).toEqual(["first-skill"])

          yield* writeSkill(dir, "second-skill")
          expect(yield* names).toEqual(["first-skill", "second-skill"])
          expect((yield* command.get("second-skill").pipe(Effect.timeout("5 seconds")))?.source).toBe("skill")
        }),
      {
        git: true,
        config: { mcp: { pending: { type: "local", command: ["sleep", "60"] } } },
      },
    ),
    30_000,
  )
})
