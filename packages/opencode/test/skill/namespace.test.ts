import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Command } from "../../src/command"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Skill } from "../../src/skill"
import { deriveNamespace } from "../../src/skill/index"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { withEnv } from "../lib/env"

withEnv({
  MIMOCODE_DISABLE_EXTERNAL_SKILLS: "true",
  MIMOCODE_DISABLE_BUILTIN_SKILLS: "true",
  MIMOCODE_DISABLE_COMPOSE_SKILLS: "true",
})

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, CrossSpawnSpawner.defaultLayer))
const commandIt = testEffect(Layer.mergeAll(Command.defaultLayer, CrossSpawnSpawner.defaultLayer))

const loc = (...parts: string[]) => path.join("/home/user/.config/mimocode", ...parts)

describe("deriveNamespace", () => {
  test("top-level skill has no namespace", () => {
    expect(deriveNamespace(loc("skills", "agent-eval", "SKILL.md"), "agent-eval")).toBeUndefined()
  })

  test("parent folder becomes the namespace", () => {
    expect(deriveNamespace(loc("skills", "ECC", "agent-eval", "SKILL.md"), "agent-eval")).toBe("ECC")
  })

  test("deep nesting uses the first segment after skills/", () => {
    expect(deriveNamespace(loc("skills", "ECC", "tools", "agent-eval", "SKILL.md"), "agent-eval")).toBe("ECC")
  })

  test("singular skill/ marker works", () => {
    expect(deriveNamespace(loc("skill", "ECC", "agent-eval", "SKILL.md"), "agent-eval")).toBe("ECC")
  })

  test("name containing a colon gets no namespace", () => {
    expect(deriveNamespace(loc("skills", "ECC", "agent-eval", "SKILL.md"), "compose:plan")).toBeUndefined()
  })

  test("namespace with whitespace is rejected", () => {
    expect(deriveNamespace(loc("skills", "My Group", "agent-eval", "SKILL.md"), "agent-eval")).toBeUndefined()
  })

  test("no skills/ marker yields no namespace", () => {
    expect(
      deriveNamespace(path.join("/home/user/.mimo-skills", "ECC", "agent-eval", "SKILL.md"), "agent-eval"),
    ).toBeUndefined()
  })
})

describe("namespaced skill discovery", () => {
  it.live("derives namespace from a nested .mimocode skill", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, ".mimocode", "skills", "ECC", "ns-test-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              "---\nname: ns-test-skill\ndescription: Test nested skill\n---\n# ns-test-skill\n",
            ),
          )
          const skill = yield* Skill.Service
          const item = (yield* skill.all()).find((s) => s.name === "ns-test-skill")
          expect(item?.namespace).toBe("ECC")
        }),
      { git: true },
    ),
  )
})

describe("namespaced skill commands", () => {
  commandIt.live("registers parent:name slash command for nested skills", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, ".mimocode", "skills", "ECC", "ns-test-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              "---\nname: ns-test-skill\ndescription: Test nested skill\n---\n# ns-test-skill\n",
            ),
          )
          const cmd = yield* Command.Service
          const all = yield* cmd.list()
          const names = new Set(all.map((c) => c.name))
          expect(names.has("ns-test-skill")).toBe(true)
          expect(names.has("ECC:ns-test-skill")).toBe(true)
          const namespaced = all.find((c) => c.name === "ECC:ns-test-skill")
          expect(namespaced?.source).toBe("skill")
        }),
      { git: true },
    ),
  )
})
