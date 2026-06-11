import { test, expect } from "bun:test"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider"
import { ProviderID } from "../../src/provider/schema"
import { SessionPrompt } from "../../src/session/prompt"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"

function resolve(ref: string, ctx?: ProviderID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.resolveModelRef(ref, ctx)
    }),
  )
}

function getSmall(ctx: ProviderID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.getSmallModel(ctx)
    }),
  )
}

// Two self-contained config providers (alpha, beta), each with one model. Fully
// declared in config (npm + models + apiKey) so they load deterministically
// without env-key autoload of models.dev providers.
const PROVIDERS = {
  alpha: {
    name: "Alpha",
    npm: "@ai-sdk/openai-compatible",
    env: [],
    models: { "alpha-1": { name: "Alpha 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
    options: { apiKey: "test-key" },
  },
  beta: {
    name: "Beta",
    npm: "@ai-sdk/openai-compatible",
    env: [],
    models: { "beta-1": { name: "Beta 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
    options: { apiKey: "test-key" },
  },
}

// All behaviors are asserted inside a SINGLE Instance.provide. The test harness
// shares a process-wide in-memory DB and a global Effect memo map, so spinning up
// one instance per test races on that shared state (a pre-existing harness
// limitation that also flakes provider.test.ts here). Using one instance with a
// config that defines every group these assertions need keeps the test
// deterministic while still exercising each resolveModelRef branch end to end.
test("resolveModelRef resolves literals and groups (provider-aware)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: PROVIDERS,
          model_groups: {
            // multi-member group: default alpha, plus beta member
            ultra: { default: "alpha/alpha-1", models: ["alpha/alpha-1", "beta/beta-1"] },
            // default-only group (no beta member) — context beta must fall back to default
            single: { default: "alpha/alpha-1", models: ["alpha/alpha-1"] },
            // string shorthand
            lite: "alpha/alpha-1",
            // disabled-member-first: beta member listed first but beta is disabled below
            guarded: { default: "alpha/alpha-1", models: ["beta/beta-1", "alpha/alpha-1"] },
          },
          disabled_providers: ["beta-disabled-marker"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 1. Literal provider/model passes through unchanged.
      const literal = await resolve("alpha/alpha-1")
      expect(String(literal.providerID)).toBe("alpha")
      expect(String(literal.id)).toBe("alpha-1")

      // 2. Group with no context provider → group default.
      const def = await resolve("ultra")
      expect(String(def.providerID)).toBe("alpha")
      expect(String(def.id)).toBe("alpha-1")

      // 3. Provider-aware: context beta → the beta member, not the default.
      const aware = await resolve("ultra", ProviderID.make("beta"))
      expect(String(aware.providerID)).toBe("beta")
      expect(String(aware.id)).toBe("beta-1")

      // 4. Context provider absent from members → group default.
      const fallback = await resolve("single", ProviderID.make("beta"))
      expect(String(fallback.providerID)).toBe("alpha")

      // 5. String shorthand group resolves to its default.
      const shorthand = await resolve("lite")
      expect(String(shorthand.id)).toBe("alpha-1")

      // 6. Unknown group name → ModelGroupNotFoundError.
      expect(resolve("nope")).rejects.toThrow(/ProviderModelGroupNotFoundError/)
    },
  })
})

// Member-skip needs beta actually disabled, which means beta must not load — so
// this case uses its own instance/config where beta is in disabled_providers.
test("resolveModelRef skips a member on a disabled provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: PROVIDERS,
          disabled_providers: ["beta"],
          model_groups: {
            // beta listed first but disabled → provider-aware scan skips it → default alpha
            ultra: { default: "alpha/alpha-1", models: ["beta/beta-1", "alpha/alpha-1"] },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = await resolve("ultra", ProviderID.make("beta"))
      expect(String(model.providerID)).toBe("alpha")
    },
  })
})

// getSmallModel routes through the `lite` tier (no `small_model` set), so a
// configured "lite" model group drives the small-model pick. Provider-aware: the
// same lite group resolves to the caller's own provider member when one exists,
// else the group default.
test("getSmallModel resolves the lite group provider-aware", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: PROVIDERS,
          model_groups: {
            lite: { default: "alpha/alpha-1", models: ["alpha/alpha-1", "beta/beta-1"] },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Context beta has a lite member → provider-aware pick (not the default, not the heuristic).
      const beta = await getSmall(ProviderID.make("beta"))
      expect(String(beta?.providerID)).toBe("beta")
      expect(String(beta?.id)).toBe("beta-1")

      // Context alpha → its own member, which is also the group default.
      const alpha = await getSmall(ProviderID.make("alpha"))
      expect(String(alpha?.providerID)).toBe("alpha")
      expect(String(alpha?.id)).toBe("alpha-1")
    },
  })
})

// The subagent spawn path (tool/actor.ts) resolves an agent's model by reading
// Info.modelRef / Info.model and (for a group) calling
// resolveModelRef(modelRef, parentProvider). The agent config now exposes a
// SINGLE `model` field that the loader routes by the presence of a `/`:
//   - no `/`  → tier/group name → Info.modelRef (resolved provider-aware later)
//   - has `/` → literal provider/model → Info.model (parsed eagerly)
// Assert both directions of that routing, plus that resolveModelRef resolves the
// tier ref provider-aware against the parent's provider.
test("agent model field routes literal vs tier name", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: PROVIDERS,
          model_groups: {
            ultra: { default: "alpha/alpha-1", models: ["alpha/alpha-1", "beta/beta-1"] },
          },
          agent: {
            reviewer: { model: "ultra", description: "test", mode: "subagent" },
            reviewer2: { model: "beta/beta-1", description: "test", mode: "subagent" },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // No-`/` value routes to a group ref.
      const info = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          return yield* agent.get("reviewer")
        }),
      )
      expect(info.modelRef).toBe("ultra")
      expect(info.model).toBeUndefined()
      // parent on beta → beta member (provider-aware)
      const onBeta = await resolve(info.modelRef!, ProviderID.make("beta"))
      expect(String(onBeta.providerID)).toBe("beta")
      // parent on alpha → alpha member (the default)
      const onAlpha = await resolve(info.modelRef!, ProviderID.make("alpha"))
      expect(String(onAlpha.providerID)).toBe("alpha")

      // A value with a `/` routes to the parsed literal model, and leaves modelRef unset.
      const literal = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          return yield* agent.get("reviewer2")
        }),
      )
      expect(String(literal.model?.providerID)).toBe("beta")
      expect(String(literal.model?.modelID)).toBe("beta-1")
      expect(literal.modelRef).toBeUndefined()
    },
  })
})

// The actor tool's per-call `model` param (highest precedence) is passed straight
// to resolveModelRef as `input.model ?? next.modelRef`. Spawning a real subagent
// through the tool is out of scope, so assert the resolver contract that
// `input.model` feeds into: it must accept BOTH a group name (resolved
// provider-aware) and a literal provider/model (resolved exactly, ignoring the
// context provider). Single Instance.provide to stay deterministic on the shared
// in-memory DB / global memo map.
test("per-call model accepts both group name and literal provider/model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: PROVIDERS,
          model_groups: {
            ultra: { default: "alpha/alpha-1", models: ["alpha/alpha-1", "beta/beta-1"] },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // input.model = "ultra" (group name) → provider-aware: context beta picks the beta member.
      const group = await resolve("ultra", ProviderID.make("beta"))
      expect(String(group.providerID)).toBe("beta")

      // input.model = "beta/beta-1" (literal) → exactly that model, IGNORING the alpha context provider.
      const literalBeta = await resolve("beta/beta-1", ProviderID.make("alpha"))
      expect(String(literalBeta.providerID)).toBe("beta")
      expect(String(literalBeta.id)).toBe("beta-1")

      // input.model = "alpha/alpha-1" (literal) → alpha, no context provider.
      const literalAlpha = await resolve("alpha/alpha-1")
      expect(String(literalAlpha.providerID)).toBe("alpha")
      expect(String(literalAlpha.id)).toBe("alpha-1")
    },
  })
})

// Built-in tiers (ultra/standard/lite) are reserved: they ALWAYS resolve. With no
// model_groups configured at all, each falls back to the default model. Setting
// top-level `model` makes defaultModel() return it deterministically, so a single
// configured model becomes all three tiers — zero-config never errors.
test("built-in tiers fall back to the default model when no model_groups configured", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: PROVIDERS,
          model: "alpha/alpha-1",
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      for (const tier of ["ultra", "standard", "lite"]) {
        const model = await resolve(tier)
        expect(String(model.providerID)).toBe("alpha")
        expect(String(model.id)).toBe("alpha-1")
      }
    },
  })
})

// A configured built-in tier still wins over the default-model fallback, and the
// two coexist: an unconfigured built-in tier falls back to the default while a
// configured one uses its group.
test("configured built-in tier wins over fallback; unconfigured coexists", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: PROVIDERS,
          model: "alpha/alpha-1",
          model_groups: {
            ultra: "beta/beta-1",
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // ultra is configured → the configured group, NOT the default alpha.
      const ultra = await resolve("ultra")
      expect(String(ultra.providerID)).toBe("beta")
      expect(String(ultra.id)).toBe("beta-1")

      // standard is an unconfigured built-in → default model.
      const standard = await resolve("standard")
      expect(String(standard.providerID)).toBe("alpha")
      expect(String(standard.id)).toBe("alpha-1")
    },
  })
})

// Spelling protection survives the built-in fallback: an unknown CUSTOM name
// (not one of the reserved tiers) still throws ModelGroupNotFoundError.
test("unknown custom group name still throws", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: PROVIDERS,
          model: "alpha/alpha-1",
          model_groups: {
            ultra: "alpha/alpha-1",
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(resolve("vision")).rejects.toThrow(/ProviderModelGroupNotFoundError/)
    },
  })
})

// SDK surface: both PromptInput and ShellInput accept an additive optional
// `modelRef` string (a group/tier name or a literal provider/model). This is the
// field HTTP/SDK callers use to start a prompt or shell with a tier name; it is
// fed straight into resolveModelRef (covered above) and takes precedence over the
// structured `model` field. Pure schema parse — no Instance/LLM needed.
test("PromptInput and ShellInput accept modelRef", () => {
  const p = SessionPrompt.PromptInput.parse({ sessionID: "ses_x", modelRef: "ultra", parts: [] })
  expect(p.modelRef).toBe("ultra")
  const s = SessionPrompt.ShellInput.parse({
    sessionID: "ses_x",
    agent: "build",
    command: "ls",
    modelRef: "anthropic/claude-x",
  })
  expect(s.modelRef).toBe("anthropic/claude-x")
})
