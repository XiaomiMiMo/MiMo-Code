import { describe, expect, spyOn } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Skill } from "../../src/skill"
import { ConfigMarkdown } from "../../src/config"
import { Permission } from "../../src/permission"
import { Filesystem } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideInstance, provideTmpdirInstance, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { withEnv } from "../lib/env"
import path from "path"
import fs from "fs/promises"

withEnv({ MIMOCODE_DISABLE_COMPOSE_SKILLS: "true", MIMOCODE_DISABLE_BUILTIN_SKILLS: "true" })

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, node))

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

async function createSkill(root: string, source: ".claude" | ".agents", name: string, description: string) {
  await Bun.write(
    path.join(root, source, "skills", name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

# ${name}
`,
  )
}

const withHome = <A, E, R>(home: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.HOME
      const prevUserProfile = process.env.USERPROFILE
      process.env.HOME = home
      process.env.USERPROFILE = home
      return { prev, prevUserProfile }
    }),
    () => self,
    ({ prev, prevUserProfile }) =>
      Effect.sync(() => {
        process.env.HOME = prev
        process.env.USERPROFILE = prevUserProfile
      }),
  )

describe("skill", () => {
  it.live("discovers skills from .mimocode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".mimocode", "skill", "test-skill", "SKILL.md"),
              `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "test-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBe("A test skill for verification.")
          expect(item!.location).toContain(path.join("skill", "test-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers repository skills without marking them as bundled", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".mimocode", "skills", "repository-skill", "SKILL.md"),
              `---
name: repository-skill
description: A repository-level skill for verification.
---

# Repository Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const item = (yield* skill.all())[0]
          expect(item?.name).toBe("repository-skill")
          expect(item?.bundled).toBeUndefined()
          expect(item?.location).toContain(path.join(".mimocode", "skills", "repository-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("returns skill directories from Skill.dirs", () =>
    provideTmpdirInstance(
      (dir) =>
        withHome(
          dir,
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".mimocode", "skill", "dir-skill", "SKILL.md"),
                `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
`,
              ),
            )

            const skill = yield* Skill.Service
            const dirs = yield* skill.dirs()
            expect(dirs).toContain(path.join(dir, ".mimocode", "skill", "dir-skill"))
            expect(dirs.length).toBe(1)
          }),
        ),
      { git: true },
    ),
  )

  it.live("discovers multiple skills from .mimocode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".mimocode", "skill", "skill-one", "SKILL.md"),
                `---
name: skill-one
description: First test skill.
---

# Skill One
`,
              ),
              Bun.write(
                path.join(dir, ".mimocode", "skill", "skill-two", "SKILL.md"),
                `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "skill-one")).toBeDefined()
          expect(list.find((x) => x.name === "skill-two")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("skips skills with missing frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".mimocode", "skill", "no-frontmatter", "SKILL.md"),
              `# No Frontmatter

Just some content without YAML frontmatter.
`,
            ),
          )

          const skill = yield* Skill.Service
          expect(yield* skill.all()).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from .claude/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
              `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "claude-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".claude", "skills", "claude-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.claude/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          yield* Effect.promise(() => createGlobalSkill(tmp.path))
          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = yield* skill.all()
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-test-skill")
            expect(list[0].description).toBe("A global skill from ~/.claude/skills for testing.")
            expect(list[0].location).toContain(path.join(".claude", "skills", "global-test-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live(
    "keeps one global snapshot across project instances until reload",
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const firstProject = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const secondProject = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )

        yield* withHome(
          home.path,
          Effect.gen(function* () {
            yield* Effect.promise(() => createSkill(home.path, ".claude", "first-global", "First snapshot"))
            const skill = yield* Skill.Service
            expect((yield* skill.all().pipe(provideInstance(firstProject.path))).map((item) => item.name)).toEqual([
              "first-global",
            ])

            yield* Effect.promise(() => createSkill(home.path, ".agents", "second-global", "Added later"))
            expect((yield* skill.all().pipe(provideInstance(secondProject.path))).map((item) => item.name)).toEqual([
              "first-global",
            ])

            yield* skill.reload().pipe(provideInstance(secondProject.path))
            expect(
              (yield* skill.all().pipe(provideInstance(secondProject.path))).map((item) => item.name).toSorted(),
            ).toEqual(["first-global", "second-global"])
          }),
        )
      }),
    30_000,
  )

  it.live(
    "uses deterministic source order when global skills share a name",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )

        yield* withHome(
          tmp.path,
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Promise.all([
                createSkill(tmp.path, ".claude", "duplicate-global", "Claude copy"),
                createSkill(tmp.path, ".agents", "duplicate-global", "Agents copy"),
              ]),
            )
            const skill = yield* Skill.Service
            const item = (yield* skill.all().pipe(provideInstance(tmp.path))).find(
              (item) => item.name === "duplicate-global",
            )
            expect(item?.description).toBe("Agents copy")
            expect(item?.location).toContain(path.join(".agents", "skills", "duplicate-global", "SKILL.md"))
          }),
        )
      }),
    30_000,
  )

  it.live("returns empty array when no skills exist", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          expect(yield* skill.all()).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from .agents/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
              `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "agent-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".agents", "skills", "agent-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.agents/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          const skillDir = path.join(tmp.path, ".agents", "skills", "global-agent-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: global-agent-skill
description: A global skill from ~/.agents/skills for testing.
---

# Global Agent Skill

This skill is loaded from the global home directory.
`,
            ),
          )

          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = yield* skill.all()
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-agent-skill")
            expect(list[0].description).toBe("A global skill from ~/.agents/skills for testing.")
            expect(list[0].location).toContain(path.join(".agents", "skills", "global-agent-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("discovers skills from .codex/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".codex", "skills", "codex-skill", "SKILL.md"),
              `---
name: codex-skill
description: A skill in the .codex/skills directory.
---

# Codex Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "codex-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBe("A skill in the .codex/skills directory.")
          expect(item!.location).toContain(path.join(".codex", "skills", "codex-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.codex/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          const skillDir = path.join(tmp.path, ".codex", "skills", "global-codex-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: global-codex-skill
description: A global skill from ~/.codex/skills for testing.
---

# Global Codex Skill

This skill is loaded from the global home directory.
`,
            ),
          )

          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = yield* skill.all()
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-codex-skill")
            expect(list[0].description).toBe("A global skill from ~/.codex/skills for testing.")
            expect(list[0].location).toContain(path.join(".codex", "skills", "global-codex-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("discovers skills from both .claude/skills/ and .agents/skills/", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "claude-skill")).toBeDefined()
          expect(list.find((x) => x.name === "agent-skill")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("properly resolves directories that skills live in", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
              Bun.write(
                path.join(dir, ".mimocode", "skill", "agent-skill", "SKILL.md"),
                `---
name: opencode-skill
description: A skill in the .mimocode/skill directory.
---

# OpenCode Skill
`,
              ),
              Bun.write(
                path.join(dir, ".mimocode", "skills", "agent-skill", "SKILL.md"),
                `---
name: opencode-skill
description: A skill in the .mimocode/skills directory.
---

# OpenCode Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.dirs()).length).toBe(4)
        }),
      { git: true },
    ),
  )

  // Model reachability is carried by the SKILL.md field, not by permission:
  // all() and available() keep such a skill so the command registry and the
  // user's slash invocation still resolve it, while modelInvocable() drops it.
  it.live("separates model reachability from the user-facing skill sets", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".mimocode", "skill", "gated-skill", "SKILL.md"),
                `---
name: gated-skill
description: Only the user may start this one.
disable-model-invocation: true
---

# Gated Skill
`,
              ),
              Bun.write(
                path.join(dir, ".mimocode", "skill", "open-skill", "SKILL.md"),
                `---
name: open-skill
description: Anyone may start this one.
---

# Open Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.get("gated-skill"))?.disable_model_invocation).toBe(true)
          expect((yield* skill.get("open-skill"))?.disable_model_invocation).toBeUndefined()

          expect((yield* skill.all()).map((item) => item.name).toSorted()).toEqual(["gated-skill", "open-skill"])
          expect((yield* skill.available()).map((item) => item.name)).toEqual(["gated-skill", "open-skill"])
          expect((yield* skill.modelInvocable()).map((item) => item.name)).toEqual(["open-skill"])
        }),
      { git: true },
    ),
  )
})

// engine-runtime: [TP-R12-01] [TP-R12-02] [TP-R12-03] [TP-R12-08]
describe("shared skill parsing", () => {
  const observeParsing = () =>
    Effect.acquireRelease(
      Effect.sync(() => spyOn(ConfigMarkdown, "parse")),
      (parse) => Effect.sync(() => parse.mockRestore()),
    )

  // [TP-R12-08]
  it.live(
    "joins a pending file read before the first parser is released",
    () =>
      Effect.gen(function* () {
        const home = yield* tmpdirScoped({ git: true })
        const first = yield* tmpdirScoped({ git: true })
        const second = yield* tmpdirScoped({ git: true })
        const file = path.join(home, ".agents", "skills", "pending", "SKILL.md")
        yield* Effect.promise(() =>
          Bun.write(file, "---\nname: pending\ndescription: Pending read\n---\nOne shared read\n"),
        )
        const original = ConfigMarkdown.parse
        const parse = yield* observeParsing()
        const stat = yield* Effect.acquireRelease(
          Effect.sync(() => spyOn(fs, "stat")),
          (spy) => Effect.sync(() => spy.mockRestore()),
        )
        const started = Promise.withResolvers<void>()
        const gate = Promise.withResolvers<void>()
        let blocked = false
        parse.mockImplementation(async (target) => {
          if (target === file && !blocked) {
            blocked = true
            started.resolve()
            await gate.promise
          }
          return original(target)
        })
        const skill = yield* Skill.Service
        yield* withHome(
          home,
          Effect.gen(function* () {
            const a = yield* skill.get("pending").pipe(provideInstance(first), Effect.forkScoped)
            try {
              yield* Effect.promise(() => started.promise).pipe(Effect.timeout("5 seconds"))
              const before = stat.mock.calls.length
              const b = yield* skill.get("pending").pipe(provideInstance(second), Effect.forkScoped)
              try {
                const index = yield* Effect.gen(function* () {
                  for (;;) {
                    const index = stat.mock.calls.findIndex(
                      (call, index) => index >= before && call[0] === file && call[1]?.bigint === true,
                    )
                    if (index >= 0) return index
                    yield* Effect.sleep("1 millis")
                  }
                }).pipe(Effect.timeout("5 seconds"))
                const result = stat.mock.results[index]
                if (!result || result.type !== "return") throw new Error("metadata lookup did not return")
                yield* Effect.promise(() => Promise.resolve(result.value))
                yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
                expect(parse.mock.calls.filter((call) => call[0] === file)).toHaveLength(1)
                gate.resolve()
                expect((yield* Fiber.join(a))?.content).toBe("One shared read\n")
                expect((yield* Fiber.join(b))?.content).toBe("One shared read\n")
              } finally {
                gate.resolve()
                yield* Fiber.await(b)
              }
            } finally {
              gate.resolve()
              yield* Fiber.await(a)
            }
          }),
        )
      }),
    30_000,
  )

  // [TP-R12-08]
  it.live(
    "does not publish a changed-during-read version into the shared cache",
    () =>
      Effect.gen(function* () {
        const home = yield* tmpdirScoped({ git: true })
        const first = yield* tmpdirScoped({ git: true })
        const second = yield* tmpdirScoped({ git: true })
        const file = path.join(home, ".agents", "skills", "changing", "SKILL.md")
        yield* Effect.promise(() =>
          Bun.write(file, "---\nname: changing\ndescription: First version\n---\nFirst body\n"),
        )
        const original = ConfigMarkdown.parse
        const parse = yield* observeParsing()
        parse.mockImplementationOnce(async (target) => {
          const parsed = await original(target)
          await fs.writeFile(file, "---\nname: changing\ndescription: Second version\n---\nSecond body\n")
          return parsed
        })
        const skill = yield* Skill.Service
        yield* withHome(
          home,
          Effect.gen(function* () {
            expect((yield* skill.get("changing").pipe(provideInstance(first)))?.content).toBe("First body\n")
            expect((yield* skill.get("changing").pipe(provideInstance(second)))?.content).toBe("Second body\n")
            expect(parse.mock.calls.filter((call) => call[0] === file)).toHaveLength(2)
          }),
        )
      }),
    30_000,
  )

  it.live(
    "coalesces global parsing across instances without sharing mutable results or permissions",
    () =>
      Effect.gen(function* () {
        const home = yield* tmpdirScoped({ git: true })
        const first = yield* tmpdirScoped({ git: true })
        const second = yield* tmpdirScoped({ git: true })
        const third = yield* tmpdirScoped({ git: true })
        const file = path.join(home, ".agents", "skills", "shared", "SKILL.md")
        yield* Effect.promise(() =>
          Bun.write(
            file,
            "---\nname: shared\ndescription: Shared instructions\naliases: [original]\n---\nOriginal body\n",
          ),
        )
        const parse = yield* observeParsing()
        const read = yield* Effect.acquireRelease(
          Effect.sync(() => spyOn(Filesystem, "readText")),
          (read) => Effect.sync(() => read.mockRestore()),
        )
        const skill = yield* Skill.Service

        yield* withHome(
          home,
          Effect.gen(function* () {
            const [a, b] = yield* Effect.all(
              [skill.get("shared").pipe(provideInstance(first)), skill.get("shared").pipe(provideInstance(second))],
              { concurrency: "unbounded" },
            )
            expect(a?.content).toBe("Original body\n")
            expect(b?.location).toBe(file)
            expect(parse).toHaveBeenCalledTimes(1)
            expect(a).not.toBe(b)
            expect(a?.aliases).not.toBe(b?.aliases)
            a!.aliases!.push("first-only")
            a!.description = "First instance only"
            a!.disable_model_invocation = true
            expect(b?.aliases).toEqual(["original"])
            expect(b?.description).toBe("Shared instructions")

            const c = yield* skill.get("shared").pipe(provideInstance(third))
            expect(c?.aliases).toEqual(["original"])
            expect(c?.disable_model_invocation).toBeUndefined()
            expect(parse).toHaveBeenCalledTimes(1)
            expect(read.mock.calls.filter(([target]) => target === file)).toHaveLength(1)
            const denied = {
              name: "test",
              mode: "all" as const,
              options: {},
              permission: Permission.fromConfig({ skill: "deny" }),
            }
            const allowed = { ...denied, permission: Permission.fromConfig({ skill: "allow" }) }
            expect(yield* skill.available(denied).pipe(provideInstance(second))).toEqual([])
            expect((yield* skill.available(allowed).pipe(provideInstance(third))).map((item) => item.name)).toEqual([
              "shared",
            ])
            expect(yield* skill.modelInvocable(allowed).pipe(provideInstance(first))).toEqual([])
            expect(
              (yield* skill.modelInvocable(allowed).pipe(provideInstance(second))).map((item) => item.name),
            ).toEqual(["shared"])
          }),
        )
      }),
    30_000,
  )

  it.live(
    "shares a physical file reached through different symlinks but preserves each discovered location",
    () =>
      Effect.gen(function* () {
        const source = yield* tmpdirScoped({ git: true })
        const first = yield* tmpdirScoped({ git: true })
        const second = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() =>
          Bun.write(path.join(source, "SKILL.md"), "---\nname: linked\ndescription: Linked source\n---\nLinked body\n"),
        )
        const roots = [first, second].map((dir) => path.join(dir, ".agents", "skills", "linked"))
        yield* Effect.promise(() =>
          Promise.all(
            roots.map(async (root) => {
              await fs.mkdir(path.dirname(root), { recursive: true })
              await fs.symlink(source, root, "junction")
            }),
          ),
        )
        const parse = yield* observeParsing()
        const skill = yield* Skill.Service
        const [a, b] = yield* Effect.all(
          [skill.get("linked").pipe(provideInstance(first)), skill.get("linked").pipe(provideInstance(second))],
          { concurrency: "unbounded" },
        )
        expect(a?.content).toBe("Linked body\n")
        expect(b?.content).toBe("Linked body\n")
        expect(a?.location).toBe(path.join(roots[0], "SKILL.md"))
        expect(b?.location).toBe(path.join(roots[1], "SKILL.md"))
        expect(yield* skill.dirs().pipe(provideInstance(first))).toEqual([roots[0]])
        expect(yield* skill.dirs().pipe(provideInstance(second))).toEqual([roots[1]])
        expect(parse).toHaveBeenCalledTimes(1)

        const replacement = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(async () => {
          await Bun.write(
            path.join(replacement, "SKILL.md"),
            "---\nname: linked\ndescription: New source\n---\nNew body\n",
          )
          await fs.unlink(roots[1])
          await fs.symlink(replacement, roots[1], "junction")
        })
        yield* skill.reload().pipe(provideInstance(second))
        expect((yield* skill.get("linked").pipe(provideInstance(second)))?.content).toBe("New body\n")
        expect((yield* skill.get("linked").pipe(provideInstance(second)))?.location).toBe(
          path.join(roots[1], "SKILL.md"),
        )
        expect((yield* skill.get("linked").pipe(provideInstance(first)))?.content).toBe("Linked body\n")
        expect(parse).toHaveBeenCalledTimes(2)
      }),
    30_000,
  )

  it.live(
    "keeps global and project definitions with the same name in their own discovery roots",
    () =>
      Effect.gen(function* () {
        const home = yield* tmpdirScoped({ git: true })
        const first = yield* tmpdirScoped({ git: true })
        const second = yield* tmpdirScoped({ git: true })
        const third = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() =>
          Promise.all([
            createSkill(home, ".agents", "same-name", "Global source"),
            createSkill(first, ".agents", "same-name", "First source"),
            createSkill(second, ".agents", "same-name", "Second source"),
            createSkill(first, ".agents", "first-only", "Not globally discovered"),
          ]),
        )
        const parse = yield* observeParsing()
        const skill = yield* Skill.Service
        yield* withHome(
          home,
          Effect.gen(function* () {
            const [a, b, c] = yield* Effect.all(
              [first, second, third].map((dir) => skill.get("same-name").pipe(provideInstance(dir))),
              { concurrency: "unbounded" },
            )
            expect(a?.description).toBe("First source")
            expect(b?.description).toBe("Second source")
            expect(c?.description).toBe("Global source")
            expect(a?.location).toBe(path.join(first, ".agents", "skills", "same-name", "SKILL.md"))
            expect(b?.location).toBe(path.join(second, ".agents", "skills", "same-name", "SKILL.md"))
            expect(yield* skill.get("first-only").pipe(provideInstance(second))).toBeUndefined()
            expect(yield* skill.get("first-only").pipe(provideInstance(third))).toBeUndefined()
            expect(yield* skill.dirs().pipe(provideInstance(second))).not.toContain(
              path.join(first, ".agents", "skills", "first-only"),
            )
            expect(parse).toHaveBeenCalledTimes(4)
          }),
        )
      }),
    30_000,
  )

  it.live(
    "reload observes changed, deleted and recreated files without mutating another instance snapshot",
    () =>
      Effect.gen(function* () {
        const home = yield* tmpdirScoped({ git: true })
        const first = yield* tmpdirScoped({ git: true })
        const second = yield* tmpdirScoped({ git: true })
        const file = path.join(home, ".agents", "skills", "versioned", "SKILL.md")
        const content = (version: string) => `---\nname: versioned\ndescription: ${version}\n---\n${version}\n`
        yield* Effect.promise(() => Bun.write(file, content("first")))
        const parse = yield* observeParsing()
        const skill = yield* Skill.Service
        yield* withHome(
          home,
          Effect.gen(function* () {
            expect((yield* skill.get("versioned").pipe(provideInstance(first)))?.content).toBe("first\n")
            expect((yield* skill.get("versioned").pipe(provideInstance(second)))?.content).toBe("first\n")
            const before = yield* Effect.promise(() => fs.stat(file))
            // Same size and restored mtime must still be recognized as a new version.
            yield* Effect.promise(async () => {
              await fs.writeFile(file, content("other"))
              await fs.utimes(file, before.atime, before.mtime)
            })
            yield* skill.reload().pipe(provideInstance(second))
            expect((yield* skill.get("versioned").pipe(provideInstance(second)))?.content).toBe("other\n")
            expect((yield* skill.get("versioned").pipe(provideInstance(first)))?.content).toBe("first\n")
            expect(parse).toHaveBeenCalledTimes(2)
            yield* skill.reload().pipe(provideInstance(first))
            expect((yield* skill.get("versioned").pipe(provideInstance(first)))?.content).toBe("other\n")
            expect(parse).toHaveBeenCalledTimes(2)

            yield* Effect.promise(() => fs.unlink(file))
            // Even a retained discovery entry must not resurrect deleted file data.
            const third = yield* tmpdirScoped({ git: true })
            expect(yield* skill.get("versioned").pipe(provideInstance(third))).toBeUndefined()
            yield* skill.reload().pipe(provideInstance(second))
            expect(yield* skill.get("versioned").pipe(provideInstance(second))).toBeUndefined()
            expect(yield* skill.dirs().pipe(provideInstance(second))).toEqual([])
            expect((yield* skill.get("versioned").pipe(provideInstance(first)))?.content).toBe("other\n")
            yield* Effect.promise(() => fs.writeFile(file, content("third")))
            yield* skill.reload().pipe(provideInstance(second))
            expect((yield* skill.get("versioned").pipe(provideInstance(second)))?.content).toBe("third\n")
            expect(parse).toHaveBeenCalledTimes(3)
          }),
        )
      }),
    30_000,
  )

  for (const invalid of [
    "---\nname: [unterminated\n---\nInvalid YAML\n",
    "---\nname: repaired\n---\nMissing description\n",
  ]) {
    it.live(
      `does not cache unsuccessful parsing: ${invalid.includes("unterminated") ? "YAML error" : "invalid schema"}`,
      () =>
        Effect.gen(function* () {
          const home = yield* tmpdirScoped({ git: true })
          const first = yield* tmpdirScoped({ git: true })
          const second = yield* tmpdirScoped({ git: true })
          const file = path.join(home, ".agents", "skills", "repaired", "SKILL.md")
          yield* Effect.promise(() => Bun.write(file, invalid))
          const parse = yield* observeParsing()
          const skill = yield* Skill.Service
          yield* withHome(
            home,
            Effect.gen(function* () {
              expect(yield* skill.all().pipe(provideInstance(first))).toEqual([])
              expect(yield* skill.all().pipe(provideInstance(second))).toEqual([])
              expect(parse).toHaveBeenCalledTimes(2)
              yield* Effect.promise(() =>
                Bun.write(file, "---\nname: repaired\ndescription: Repaired source\n---\nWorking body\n"),
              )
              yield* skill.reload().pipe(provideInstance(second))
              expect((yield* skill.get("repaired").pipe(provideInstance(second)))?.content).toBe("Working body\n")
              expect(parse).toHaveBeenCalledTimes(3)
            }),
          )
        }),
      30_000,
    )
  }
})
