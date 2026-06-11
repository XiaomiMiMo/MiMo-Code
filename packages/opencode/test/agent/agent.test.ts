import { afterEach, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { provideInstance, tmpdir, provideTmpdirInstance } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { ToolRegistry } from "../../src/tool"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const itTool = testEffect(
  Layer.mergeAll(ToolRegistry.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): Permission.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("returns default native agents when no config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await load(tmp.path, (svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).toContain("build")
      expect(names).toContain("plan")
      expect(names).toContain("general")
      expect(names).toContain("explore")
      expect(names).toContain("title")
      expect(names).toContain("summary")
    },
  })
})

test("build agent has correct default properties", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(build?.mode).toBe("primary")
      expect(build?.native).toBe(true)
      expect(evalPerm(build, "edit")).toBe("allow")
      expect(evalPerm(build, "bash")).toBe("allow")
    },
  })
})

test("plan agent denies edits except .mimocode/plans/*", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await load(tmp.path, (svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      // Wildcard is denied
      expect(evalPerm(plan, "edit")).toBe("deny")
      // But specific path is allowed
      expect(Permission.evaluate("edit", ".mimocode/plans/foo.md", plan!.permission).action).toBe("allow")
    },
  })
})

test("explore agent denies edit and write", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await load(tmp.path, (svc) => svc.get("explore"))
      expect(explore).toBeDefined()
      expect(explore?.mode).toBe("subagent")
      expect(evalPerm(explore, "edit")).toBe("deny")
      expect(evalPerm(explore, "write")).toBe("deny")
      expect(evalPerm(explore, "todowrite")).toBe("deny")
    },
  })
})

test("explore agent asks for external directories and allows Truncate.GLOB", async () => {
  const { Truncate } = await import("../../src/tool")
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await load(tmp.path, (svc) => svc.get("explore"))
      expect(explore).toBeDefined()
      expect(Permission.evaluate("external_directory", "/some/other/path", explore!.permission).action).toBe("ask")
      expect(Permission.evaluate("external_directory", Truncate.GLOB, explore!.permission).action).toBe("allow")
    },
  })
})

test("general agent denies todo tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const general = await load(tmp.path, (svc) => svc.get("general"))
      expect(general).toBeDefined()
      expect(general?.mode).toBe("subagent")
      expect(general?.hidden).toBeUndefined()
      expect(evalPerm(general, "todowrite")).toBe("deny")
    },
  })
})

test("custom agent from config creates new agent", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const custom = await load(tmp.path, (svc) => svc.get("my_custom_agent"))
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    },
  })
})

test("custom agent config overrides native agent properties", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(String(build?.model?.providerID)).toBe("anthropic")
      expect(String(build?.model?.modelID)).toBe("claude-3")
      expect(build?.description).toBe("Custom build agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    },
  })
})

test("agent disable removes agent from list", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await load(tmp.path, (svc) => svc.get("explore"))
      expect(explore).toBeUndefined()
      const agents = await load(tmp.path, (svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    },
  })
})

test("agent permission config merges with defaults", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build).toBeDefined()
      // Specific pattern is denied
      expect(Permission.evaluate("bash", "rm -rf *", build!.permission).action).toBe("deny")
      // Edit still allowed
      expect(evalPerm(build, "edit")).toBe("allow")
    },
  })
})

test("global permission config applies to all agents", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        bash: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(evalPerm(build, "bash")).toBe("deny")
    },
  })
})

test("agent steps/maxSteps config sets steps property", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      const plan = await load(tmp.path, (svc) => svc.get("plan"))
      expect(build?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    },
  })
})

test("agent mode can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await load(tmp.path, (svc) => svc.get("explore"))
      expect(explore?.mode).toBe("primary")
    },
  })
})

test("agent name can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { name: "Builder" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build?.name).toBe("Builder")
    },
  })
})

test("agent prompt can be set from config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { prompt: "Custom system prompt" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build?.prompt).toBe("Custom system prompt")
    },
  })
})

test("unknown agent properties are placed into options", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    },
  })
})

test("agent options merge correctly", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    },
  })
})

test("multiple custom agents can be defined", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agentA = await load(tmp.path, (svc) => svc.get("agent_a"))
      const agentB = await load(tmp.path, (svc) => svc.get("agent_b"))
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    },
  })
})

test("Agent.list keeps the default agent first, then native primaries, then the rest by name", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "plan",
      agent: {
        zebra: {
          description: "Zebra",
          mode: "subagent",
        },
        alpha: {
          description: "Alpha",
          mode: "subagent",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const names = (await load(tmp.path, (svc) => svc.list())).map((a) => a.name)
      // default_agent comes first
      expect(names[0]).toBe("plan")
      expect(names[1]).toBe("build")
      expect(names[2]).toBe("compose")
    },
  })
})

test("Agent.get returns undefined for non-existent agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const nonExistent = await load(tmp.path, (svc) => svc.get("does_not_exist"))
      expect(nonExistent).toBeUndefined()
    },
  })
})

test("default permission includes doom_loop and external_directory as ask", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(evalPerm(build, "doom_loop")).toBe("ask")
      expect(evalPerm(build, "external_directory")).toBe("ask")
    },
  })
})

test("webfetch is allowed by default", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(evalPerm(build, "webfetch")).toBe("allow")
    },
  })
})

test("legacy tools config converts to permissions", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    },
  })
})

test("legacy tools config maps write/edit/patch/multiedit to edit permission", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          tools: {
            write: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(evalPerm(build, "edit")).toBe("deny")
    },
  })
})

test("Truncate.GLOB is allowed even when user denies external_directory globally", async () => {
  const { Truncate } = await import("../../src/tool")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    },
  })
})

test("Truncate.GLOB is allowed even when user denies external_directory per-agent", async () => {
  const { Truncate } = await import("../../src/tool")
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    },
  })
})

test("explicit Truncate.GLOB deny is respected", async () => {
  const { Truncate } = await import("../../src/tool")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.GLOB]: "deny",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
    },
  })
})

test("skill directories are allowed for external_directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".mimocode", "skill", "perm-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
      )
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
        const skillDir = path.join(tmp.path, ".mimocode", "skill", "perm-skill")
        const target = path.join(skillDir, "reference", "notes.md")
        expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("allow")
      },
    })
  } finally {
    process.env.HOME = home
    process.env.USERPROFILE = userProfile
  }
})

test("defaultAgent returns build when no default_agent config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("build")
    },
  })
})

test("defaultAgent respects default_agent config set to plan", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "plan",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("plan")
    },
  })
})

test("defaultAgent respects default_agent config set to custom agent with mode all", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("my_custom")
    },
  })
})

test("defaultAgent throws when default_agent points to subagent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "explore",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow('default agent "explore" is a subagent')
    },
  })
})

test("defaultAgent throws when default_agent points to hidden agent", async () => {
  // Use a custom hidden+primary agent so this test exercises the "is hidden"
  // branch in defaultAgent(). Native hidden agents (title/summary/checkpoint-writer)
  // are subagents, which would short-circuit on the earlier "is a subagent"
  // branch instead.
  await using tmp = await tmpdir({
    config: {
      default_agent: "secret_primary",
      agent: {
        secret_primary: {
          description: "Hidden primary agent",
          mode: "primary",
          hidden: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow(
        'default agent "secret_primary" is hidden',
      )
    },
  })
})

test("defaultAgent throws when default_agent points to non-existent agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "does_not_exist",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow(
        'default agent "does_not_exist" not found',
      )
    },
  })
})

test("defaultAgent returns plan when build is disabled and default_agent not set", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("plan")
    },
  })
})

test("defaultAgent throws when all primary agents are disabled", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { disable: true },
        plan: { disable: true },
        compose: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // build, plan, and compose are disabled, no primary-capable agents remain
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow("no primary visible agent found")
    },
  })
})

test("bounded computation agents are exactly title, summary, compaction, checkpoint-writer, dream, distill", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await load(tmp.path, (svc) => svc.list())
      const boundedComputations = agents
        .filter((a) => a.native === true && a.hidden === true)
        .map((a) => a.name)
        .sort()
      expect(boundedComputations).toEqual(["checkpoint-writer", "compaction", "distill", "dream", "summary", "title"])

      // Spot-check a few durable agents are NOT classified as bounded.
      const build = agents.find((a) => a.name === "build")
      expect(build?.native).toBe(true)
      expect(build?.hidden).toBeFalsy()

      const plan = agents.find((a) => a.name === "plan")
      expect(plan?.native).toBe(true)
      expect(plan?.hidden).toBeFalsy()
    },
  })
})

test("checkpoint-writer inherits default permission (no bespoke block); memory writes governed by memory-path-guard", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cp = await load(tmp.path, (svc) => svc.get("checkpoint-writer"))
      expect(cp).toBeDefined()
      // The writer no longer declares its own "*":"deny" + per-tool allows.
      // It inherits `defaults` (which is "*":"allow") + user config, identical
      // to how any default agent resolves. Tool-visibility parity with the
      // parent is what restores prompt-cache hits — at runtime the fork passes
      // the PARENT's permission to handle.process (see prompt.ts fork branch),
      // and memory writes are governed by memory-path-guard (askEditUnlessMemory),
      // so an inherited edit:deny never blocks the writer's own checkpoint files.
      // Under default config, edit/write/read resolve to "allow".
      expect(Permission.evaluate("edit", "any/path", cp!.permission).action).toBe("allow")
      expect(Permission.evaluate("write", "any/path", cp!.permission).action).toBe("allow")
      expect(Permission.evaluate("read", "any/path", cp!.permission).action).toBe("allow")
      // bash is no longer force-disabled by a "*":"deny" block — it inherits the
      // default allow, matching the parent's visible tool schema (prompt-cache parity).
      const disabled = Permission.disabled(["read", "write", "edit", "bash", "webfetch"], cp!.permission)
      expect(disabled.has("bash")).toBe(false)
      expect(disabled.has("webfetch")).toBe(false)
    },
  })
})

test("checkpoint-writer agent has no toolAllowlist (fork agents must mirror parent's tool schema)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cp = await load(tmp.path, (svc) => svc.get("checkpoint-writer"))
      expect(cp).toBeDefined()
      expect(cp?.toolAllowlist).toBeUndefined()
      // apply_patch is now permission-allowed (for GPT-5+ models where it
      // replaces edit/write at the registry patch-swap step)
      expect(Permission.evaluate("apply_patch", "any/path", cp!.permission).action).toBe("allow")
    },
  })
})

test("checkpoint-writer inherits provider system prompt (prefix-cache alignment)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cp = await load(tmp.path, (svc) => svc.get("checkpoint-writer"))
      // Regression guard: if a future change re-sets `prompt` on checkpoint-writer,
      // the child writer session will send a DIFFERENT system prompt from its
      // contextFrom parent, breaking Anthropic's prefix cache for the 80K+
      // inherited messages. The writer-specific instructions must be injected
      // into the first user message instead (see src/session/checkpoint.ts).
      expect(cp?.prompt).toBeUndefined()
    },
  })
})

// agent registry — spawnable filter (F24)
//
// title/summary/checkpoint-writer are internal infrastructure agents that
// never run as primary entry points — they're spawned programmatically.
// The "primary" + "hidden" combo was a workaround that produced correct
// UI behavior but mis-classified their semantic role. Switch to "subagent"
// + keep "hidden: true" so the actor tool's describeTask filter (which
// must reject both primary and hidden agents) does not expose them.
test("title/summary/checkpoint-writer are mode=subagent + hidden (spawnable filter F24)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      for (const name of ["title", "summary", "checkpoint-writer"]) {
        const a = await load(tmp.path, (svc) => svc.get(name))
        expect(a, `agent ${name}`).toBeDefined()
        expect(a?.mode, `agent ${name} mode`).toBe("subagent")
        expect(a?.hidden, `agent ${name} hidden`).toBe(true)
      }
    },
  })
})

// Regression for ses_19d1aa927: the fork agent (checkpoint-writer) inherits
// compose's tool list verbatim (Task 2.6 removed toolAllowlist). This test
// confirms the patch-swap in registry.ts fires correctly per model family.
itTool.live("compose's tool list contains apply_patch on GPT-5+ but not on Claude", () =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const compose = yield* agents.get("compose")
      expect(compose).toBeDefined()

      const registry = yield* ToolRegistry.Service

      const gptTools = yield* registry.tools({
        modelID: ModelID.make("gpt-5.5"),
        providerID: ProviderID.make("openai"),
        agent: compose!,
      })
      const gptIDs = gptTools.map((t) => t.id)
      expect(gptIDs).toContain("apply_patch")
      expect(gptIDs).not.toContain("edit")
      expect(gptIDs).not.toContain("write")

      const claudeTools = yield* registry.tools({
        modelID: ModelID.make("claude-opus-4-7"),
        providerID: ProviderID.make("anthropic"),
        agent: compose!,
      })
      const claudeIDs = claudeTools.map((t) => t.id)
      expect(claudeIDs).toContain("edit")
      expect(claudeIDs).toContain("write")
      expect(claudeIDs).not.toContain("apply_patch")
    }),
  ),
)
