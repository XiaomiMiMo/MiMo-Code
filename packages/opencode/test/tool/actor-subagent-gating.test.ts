import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ToolRegistry } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { hasActorTool } from "../../src/agent/config"
import { ProviderID, ModelID } from "../../src/provider/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

const it = testEffect(
  Layer.mergeAll(ToolRegistry.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

afterEach(async () => {
  await Instance.disposeAll()
})

const ids = (agent: Agent.Info) =>
  Effect.gen(function* () {
    const tools = yield* (yield* ToolRegistry.Service).tools({
      providerID: ProviderID.opencode,
      modelID: ModelID.make("opencode/claude-sonnet-4-6"),
      agent,
    })
    return tools.map((t) => t.id)
  })

const get = (name: string) =>
  Effect.gen(function* () {
    const agent = yield* (yield* Agent.Service).get(name)
    if (!agent) throw new Error(`no ${name} agent`)
    return agent
  })

// `actor` is the only tool that spawns child agents, so no `mode: "subagent"`
// agent may see it — otherwise a subagent recursively delegates its own work.
// The gate is on mode, not name, so a user-config subagent (which defaults to
// `"*": "allow"`) cannot opt itself back in.
describe("ToolRegistry.tools: actor tool subagent gating", () => {
  it.live("primaries still see the actor tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        expect(yield* ids(yield* get("build"))).toContain("actor")
      }),
    ),
  )

  it.live("native subagents do not see the actor tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        expect(yield* ids(yield* get("general"))).not.toContain("actor")
        expect(yield* ids(yield* get("explore"))).not.toContain("actor")
      }),
    ),
  )

  it.live("user-config subagents do not see the actor tool", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const helper = yield* get("helper")
          expect(helper.mode).toBe("subagent")
          expect(helper.toolAllowlist).toBeUndefined()
          const tools = yield* ids(helper)
          expect(tools).not.toContain("actor")
          // still full-capability otherwise — the gate removes only `actor`
          expect(tools).toContain("edit")
          expect(tools).toContain("bash")
        }),
      { config: { agent: { helper: { description: "Helper", mode: "subagent" } } } },
    ),
  )

  // checkpoint-writer is a fork agent: its LLM-visible tool schema must stay
  // byte-identical to the primary parent's captured ForkContext.tools or the
  // prefix cache breaks. Its real authority is the actor.tools whitelist in
  // tryStartCheckpointWriter, which already omits `actor`.
  it.live("checkpoint-writer keeps actor in its schema (fork prefix-cache parity)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const writer = yield* get("checkpoint-writer")
        expect(writer.mode).toBe("subagent")
        expect(yield* ids(writer)).toEqual(yield* ids(yield* get("build")))
      }),
    ),
  )

  // Prompt surfaces name `actor` based on hasActorTool rather than resolving the
  // schema, so the predicate must agree with the mask for every registered agent
  // — otherwise a reminder points at a tool the model has no schema for.
  it.live("hasActorTool agrees with the mask for every agent", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agents = yield* (yield* Agent.Service).list()
          for (const agent of agents) {
            expect({ agent: agent.name, actor: (yield* ids(agent)).includes("actor") }).toEqual({
              agent: agent.name,
              actor: hasActorTool(agent),
            })
          }
        }),
      { config: { agent: { helper: { description: "Helper", mode: "subagent" } } } },
    ),
  )
})
