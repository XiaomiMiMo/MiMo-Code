import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SystemPrompt } from "../../src/session/system"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

const dynamicSystemPrompt = process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT
const codexMode = process.env.MIMOCODE_CODEX_MODE

beforeEach(() => {
  process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT = "true"
  delete process.env.MIMOCODE_CODEX_MODE
})

afterEach(() => {
  if (dynamicSystemPrompt === undefined) delete process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT
  else process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT = dynamicSystemPrompt
  if (codexMode === undefined) delete process.env.MIMOCODE_CODEX_MODE
  else process.env.MIMOCODE_CODEX_MODE = codexMode
})

describe("session.system", () => {
  test("does not render dynamic environment information by default", async () => {
    delete process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const prompt = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* SystemPrompt.Service).environment(ProviderTest.model())
          }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
        )

        expect(prompt).toEqual([])
      },
    })
  })

  test("every model receives the same default prompt outside Codex mode", () => {
    const models = [
      ProviderTest.model({ id: ModelID.make("gpt-5.4"), api: { id: "gpt-5.4" } as never }),
      ProviderTest.model({
        id: ModelID.make("claude-sonnet-4-6"),
        providerID: ProviderID.make("anthropic"),
        api: { id: "claude-sonnet-4-6" } as never,
      }),
      ProviderTest.model({ id: ModelID.make("gemini-2.5-pro"), api: { id: "gemini-2.5-pro" } as never }),
      ProviderTest.model({ id: ModelID.make("deepseek-v4"), api: { id: "deepseek-v4" } as never }),
      ProviderTest.model({ id: ModelID.make("mimo-v2.6"), api: { id: "mimo-v2.6" } as never }),
    ]
    const prompts = models.flatMap((model) =>
      [undefined, "auto", "default"].map((harness) => SystemPrompt.provider(model, harness as never)[0]),
    )

    expect(new Set(prompts).size).toBe(1)
    expect(prompts[0]).not.toContain("You are Codex")
    expect(prompts[0]).not.toContain("tools.apply_patch")
  })

  test("Codex mode selects its own prompt for every model", () => {
    const gpt = ProviderTest.model({ id: ModelID.make("gpt-5.4"), api: { id: "gpt-5.4" } as never })
    const mimo = ProviderTest.model({ id: ModelID.make("mimo-v2.6"), api: { id: "mimo-v2.6" } as never })
    const codex = SystemPrompt.provider(mimo, "codex")[0]

    expect(codex).toContain("You are Codex")
    expect(codex).toContain("tools.apply_patch")
    expect(SystemPrompt.provider(gpt, "codex")[0]).toBe(codex)

    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(SystemPrompt.provider(gpt)[0]).toBe(codex)
    expect(SystemPrompt.provider(mimo, "auto")[0]).toBe(codex)
    expect(SystemPrompt.provider(mimo, "default")[0]).not.toBe(codex)
  })

  test("disabled Codex mode overrides an explicit codex harness", () => {
    const model = ProviderTest.model({ id: ModelID.make("gpt-5.4"), api: { id: "gpt-5.4" } as never })
    const normal = SystemPrompt.provider(model)[0]
    process.env.MIMOCODE_CODEX_MODE = "false"

    expect(SystemPrompt.provider(model, "codex")[0]).toBe(normal)
  })

  test("Codex prompt aligns exec and parallel-call guidance", () => {
    const prompt = SystemPrompt.provider(ProviderTest.model(), "codex")[0]

    expect(prompt).toContain("Parallelize only tool calls that are independent")
    expect(prompt).toContain("keep dependencies sequential")
    expect(prompt).toContain("including a single small call")
    expect(prompt).toContain("tools.<name>(...)")
    expect(prompt).toContain('tools.skill({ name: "<skill-name>" })')
    expect(prompt).toContain("return result.output")
    expect(prompt).toContain("never call an unavailable top-level `skill`")
    expect(prompt).not.toContain("When possible, prefer parallelization over sequential tool calls")
  })

  test("renders the same environment block for every model without repository snapshots", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "dirty.txt"), "dirty\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const prompts = await Effect.runPromise(
          Effect.gen(function* () {
            const system = yield* SystemPrompt.Service
            return yield* Effect.all([
              system.environment(
                ProviderTest.model({
                  id: ModelID.make("claude-sonnet-4-6"),
                  providerID: ProviderID.make("anthropic"),
                  api: { id: "claude-sonnet-4-6" } as never,
                }),
              ),
              system.environment(ProviderTest.model({ id: ModelID.make("mimo-v2.6"), api: { id: "mimo-v2.6" } as never })),
            ])
          }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
        )
        const claude = prompts[0].join("\n")
        const mimo = prompts[1].join("\n")

        for (const text of [claude, mimo]) {
          expect(text).toContain("<env>")
          expect(text).toContain(`  Working directory: ${tmp.path}`)
          expect(text).not.toContain("# Environment")
          expect(text).not.toContain("gitStatus:")
          expect(text).not.toContain("dirty.txt")
        }
        expect(claude).toContain("The exact model ID is anthropic/claude-sonnet-4-6")
      },
    })
  })

  test("uses the same prompted subagent system across models", () => {
    const subagent = {
      name: "general",
      mode: "subagent" as const,
      prompt: "You are a full-capability general-purpose subagent.",
      permission: [],
      options: {},
    }
    const gpt = SystemPrompt.agent(
      subagent,
      ProviderTest.model({ id: ModelID.make("gpt-5.4"), api: { id: "deployment-primary" } as never }),
    )
    const claude = SystemPrompt.agent(
      subagent,
      ProviderTest.model({ id: ModelID.make("claude-sonnet-4-6"), api: { id: "claude-sonnet-4-6" } as never }),
    )

    expect(gpt).toEqual([subagent.prompt])
    expect(claude).toEqual(gpt)
  })

  test("vision capability guidance depends only on the model's image capability", async () => {
    await using tmp = await tmpdir({ git: true })
    const textOnly = (id: string) => {
      const model = ProviderTest.model({ id: ModelID.make(id), api: { id } as never })
      return { ...model, capabilities: { ...model.capabilities, input: { ...model.capabilities.input, image: false } } }
    }
    const vision = (id: string) => {
      const model = ProviderTest.model({ id: ModelID.make(id), api: { id } as never })
      return { ...model, capabilities: { ...model.capabilities, input: { ...model.capabilities.input, image: true } } }
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const prompts = await Effect.runPromise(
          Effect.gen(function* () {
            const system = yield* SystemPrompt.Service
            return yield* Effect.all([
              system.environment(textOnly("gpt-5.4")),
              system.environment(textOnly("claude-sonnet-4-6")),
              system.environment(textOnly("mimo-v2.6")),
              system.environment(vision("gpt-5.4")),
            ])
          }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
        )

        expect(prompts[0].join("\n")).toContain("<vision-capability>")
        expect(prompts[1].join("\n")).toContain("<vision-capability>")
        expect(prompts[2].join("\n")).toContain("<vision-capability>")
        expect(prompts[3].join("\n")).not.toContain("<vision-capability>")
      },
    })
  })

  test("skill catalog does not include invocation reminders", async () => {
    await using tmp = await tmpdir({ git: true })
    const home = process.env.HOME
    const userProfile = process.env.USERPROFILE
    process.env.HOME = tmp.path
    process.env.USERPROFILE = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await load(tmp.path, (svc) => svc.get("build"))
          const prompt = await Effect.runPromise(
            Effect.gen(function* () {
              return yield* (yield* SystemPrompt.Service).skills(build!)
            }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
          )

          expect(prompt).toContain("Skills available in this session:")
          expect(prompt).not.toContain("first user query")
          expect(prompt).not.toContain("skill_search")
          expect(prompt).not.toContain("Use the skill tool")
        },
      })
    } finally {
      process.env.HOME = home
      process.env.USERPROFILE = userProfile
    }
  })

  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".mimocode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.HOME
    const userProfile = process.env.USERPROFILE
    process.env.HOME = tmp.path
    process.env.USERPROFILE = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await load(tmp.path, (svc) => svc.get("build"))
          const runSkills = Effect.gen(function* () {
            const svc = yield* SystemPrompt.Service
            return yield* svc.skills(build!)
          }).pipe(Effect.provide(SystemPrompt.defaultLayer))

          const first = await Effect.runPromise(runSkills)
          const second = await Effect.runPromise(runSkills)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.HOME = home
      process.env.USERPROFILE = userProfile
    }
  })

})
