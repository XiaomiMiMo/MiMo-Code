import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import os from "os"
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

describe("session.system", () => {
  test("Anthropic template does not contain machine-specific snapshots", () => {
    const prompt = SystemPrompt.provider(
      ProviderTest.model({
        id: ModelID.make("claude-sonnet-4-6"),
        providerID: ProviderID.make("anthropic"),
        api: { id: "claude-sonnet-4-6" } as never,
      }),
    )[0]

    expect(prompt).not.toContain("/Users/mi/Desktop/MCracker")
    expect(prompt).not.toContain("feat/wiki-seal-cot-recovery")
    expect(prompt).not.toContain("# Environment")
    expect(prompt).not.toContain("gitStatus:")
  })

  test("renders machine and repository environment only for Claude models", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git branch -M prompt-test`.cwd(tmp.path).quiet()
    await $`git config init.defaultBranch prompt-test`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "dirty.txt"), "dirty\n")
    const now = Date.UTC(2026, 6, 30)

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
                  name: "Claude Sonnet 4.6",
                  api: { id: "claude-sonnet-4-6-20260730" } as never,
                }),
                now,
              ),
              system.environment(ProviderTest.model(), now),
            ])
          }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
        )
        const claude = prompts[0].join("\n")
        const gpt = prompts[1].join("\n")

        expect(claude).toContain("# Environment")
        expect(claude).toContain(` - Primary working directory: ${tmp.path}`)
        expect(claude).toContain(` - Platform: ${process.platform}`)
        expect(claude).toContain(` - OS Version: ${os.type()} ${os.release()}`)
        expect(claude).toContain("The exact model ID is anthropic/claude-sonnet-4-6-20260730")
        expect(claude).toContain("Current branch: prompt-test")
        expect(claude).toContain("Main branch (you will usually use this for PRs): prompt-test")
        expect(claude).toContain("Git user: Test")
        expect(claude).toContain("?? dirty.txt")
        expect(claude).toContain("root commit")
        expect(gpt).not.toContain("gitStatus:")
        expect(gpt).not.toContain("Current branch:")
        expect(gpt).not.toContain("Git user:")
      },
    })
  })

  test("uses the selected system template to decide whether to render the Claude environment", async () => {
    await using tmp = await tmpdir({ git: true })
    const now = Date.UTC(2026, 6, 30)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const prompts = await Effect.runPromise(
          Effect.gen(function* () {
            const system = yield* SystemPrompt.Service
            return yield* Effect.all([
              system.environment(
                ProviderTest.model({
                  id: ModelID.make("gpt-fast"),
                  api: { id: "claude-sonnet-4-6" } as never,
                }),
                now,
              ),
              system.environment(
                ProviderTest.model({
                  id: ModelID.make("custom-model"),
                  api: { id: "claude-sonnet-4-6" } as never,
                }),
                now,
              ),
            ])
          }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
        )

        expect(prompts[0].join("\n")).not.toContain("gitStatus:")
        expect(prompts[1].join("\n")).toContain("gitStatus:")
      },
    })
  })

  test("keeps the Claude repository snapshot stable for a session", async () => {
    await using tmp = await tmpdir({ git: true })
    const now = Date.UTC(2026, 6, 30)
    const model = ProviderTest.model({
      id: ModelID.make("claude-sonnet-4-6"),
      providerID: ProviderID.make("anthropic"),
      api: { id: "claude-sonnet-4-6" } as never,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const render = () =>
          Effect.runPromise(
            Effect.gen(function* () {
              return yield* (yield* SystemPrompt.Service).environment(model, now)
            }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
          )
        const first = await render()
        await Bun.write(path.join(tmp.path, "created-after-render.txt"), "later\n")
        const second = await render()

        expect(second).toEqual(first)
        expect(second.join("\n")).not.toContain("created-after-render.txt")
      },
    })
  })

  test("GPT prompt aligns exec and parallel-call guidance", () => {
    const prompt = SystemPrompt.provider(ProviderTest.model())[0]

    expect(prompt).toContain("Parallelize only tool calls that are independent")
    expect(prompt).toContain("keep dependencies sequential")
    expect(prompt).toContain("only one small call is needed")
    expect(prompt).not.toContain("When possible, prefer parallelization over sequential tool calls")
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

  test("prefers the catalog model ID when the API deployment ID is opaque", () => {
    const prompt = SystemPrompt.provider(
      ProviderTest.model({
        id: ModelID.make("gpt-5.4"),
        api: { id: "deployment-primary" } as never,
      }),
    )[0]

    expect(prompt).toContain("You are MiMoCode, an agent based on the GPT-5 family")
  })

  test("does not inject vision capability guidance for GPT, Claude, or Gemini models", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const prompts = await Effect.runPromise(
          Effect.gen(function* () {
            const system = yield* SystemPrompt.Service
            return yield* Effect.all([
              system.environment(
                ProviderTest.model({ id: ModelID.make("gpt-5.4"), api: { id: "gpt-5.4" } as never }),
                Date.now(),
              ),
              system.environment(
                ProviderTest.model({
                  id: ModelID.make("claude-sonnet-4-6"),
                  providerID: ProviderID.make("anthropic"),
                  api: { id: "claude-sonnet-4-6" } as never,
                }),
                Date.now(),
              ),
              system.environment(
                ProviderTest.model({
                  id: ModelID.make("gemini-2.5-pro"),
                  providerID: ProviderID.make("google"),
                  api: { id: "gemini-2.5-pro" } as never,
                }),
                Date.now(),
              ),
            ])
          }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
        )

        expect(prompts[0].join("\n")).not.toContain("<vision-capability>")
        expect(prompts[1].join("\n")).not.toContain("<vision-capability>")
        expect(prompts[2].join("\n")).not.toContain("<vision-capability>")
      },
    })
  })

  test("prompts the model to search skills from the first user query", async () => {
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

          expect(prompt).toContain("first user query")
          expect(prompt).toContain("might benefit from a specialized workflow")
          expect(prompt).toContain("skill_search")
          expect(prompt).toContain("action")
          expect(prompt).toContain("input")
          expect(prompt).toContain("output")
          expect(prompt).toContain("audience")
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

  test("does not prompt GPT or Claude models to use skill_search", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await load(tmp.path, (svc) => svc.get("build"))
        const prompts = await Effect.runPromise(
          Effect.gen(function* () {
            const system = yield* SystemPrompt.Service
            return yield* Effect.all([
              system.skills(build!, { id: "gpt-5.4" }),
              system.skills(build!, { id: "claude-sonnet-4-6" }),
              system.skills(build!, { id: "mimo-v2" }),
            ])
          }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
        )

        expect(prompts[0]).not.toContain("skill_search")
        expect(prompts[1]).not.toContain("skill_search")
        expect(prompts[2]).toContain("skill_search")
      },
    })
  })
})
