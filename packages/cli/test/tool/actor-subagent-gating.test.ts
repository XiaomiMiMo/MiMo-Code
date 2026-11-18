import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ToolRegistry } from "../../src/tool"
import { SUBAGENT_ACTOR_DESCRIPTION } from "../../src/tool/actor"
import { Agent } from "../../src/agent/agent"
import { actorToolVariant, hasActorTool } from "../../src/agent/config"
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
// agent gets the spawn surface: it receives the send-only variant instead. The
// gate is on mode, not name, so a user-config subagent (which defaults to
// `"*": "allow"`) cannot opt itself back into spawning.
describe("ToolRegistry.tools: actor tool subagent gating", () => {
  it.live("primaries still see the actor tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        expect(yield* ids(yield* get("build"))).toContain("actor")
      }),
    ),
  )

  it.live("native subagents see the send-only actor tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        for (const name of ["general", "explore"]) {
          const agent = yield* get(name)
          expect(yield* ids(agent)).toContain("actor")
          const tools = yield* (yield* ToolRegistry.Service).tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("opencode/claude-sonnet-4-6"),
            agent,
          })
          const actor = tools.find((tool) => tool.id === "actor")
          expect(actor?.description).toBe(SUBAGENT_ACTOR_DESCRIPTION)
          // the spawn surface is gone from the schema, not merely rejected later
          const spawn = actor?.parameters.safeParse({
            operation: { action: "spawn", description: "x", prompt: "y", subagent_type: "explore" },
          })
          expect(spawn?.success).toBe(false)
          const send = actor?.parameters.safeParse({
            operation: { action: "send", to_actor_id: "main", content: "blocked on X" },
          })
          expect(send?.success).toBe(true)
        }
      }),
    ),
  )

  it.live("user-config subagents get the send-only variant too", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const helper = yield* get("helper")
          expect(helper.mode).toBe("subagent")
          expect(helper.toolAllowlist).toBeUndefined()
          const tools = yield* ids(helper)
          expect(tools).toContain("actor")
          // still full-capability otherwise — only the actor surface is reduced
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

  // actorToolVariant is the predicate ToolRegistry.available switches on, so it
  // must agree with the resulting schema for every registered agent.
  it.live("actorToolVariant agrees with the schema for every agent", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agents = yield* (yield* Agent.Service).list()
          for (const agent of agents) {
            const variant = actorToolVariant(agent)
            const tools = yield* (yield* ToolRegistry.Service).tools({
              providerID: ProviderID.opencode,
              modelID: ModelID.make("opencode/claude-sonnet-4-6"),
              agent,
            })
            const actor = tools.find((tool) => tool.id === "actor")
            expect({ agent: agent.name, present: actor !== undefined }).toEqual({
              agent: agent.name,
              present: variant !== "none",
            })
            if (variant === "send") expect(actor?.description).toBe(SUBAGENT_ACTOR_DESCRIPTION)
            if (variant === "full") expect(actor?.description).not.toBe(SUBAGENT_ACTOR_DESCRIPTION)
          }
        }),
      { config: { agent: { helper: { description: "Helper", mode: "subagent" } } } },
    ),
  )
})

describe("actorToolVariant", () => {
  test("primaries, peers and system-spawned agents get the full surface", () => {
    expect(actorToolVariant({ name: "build", mode: "primary" })).toBe("full")
    expect(actorToolVariant({ name: "helper", mode: "all" })).toBe("full")
    expect(actorToolVariant({ name: "checkpoint-writer", mode: "subagent" })).toBe("full")
    expect(actorToolVariant(undefined)).toBe("full")
  })

  test("other subagents get send only", () => {
    expect(actorToolVariant({ name: "general", mode: "subagent" })).toBe("send")
    expect(actorToolVariant({ name: "explore", mode: "subagent" })).toBe("send")
  })

  // dream/distill are system-spawned, so the mode gate would exempt them, but
  // their toolAllowlist omits `actor`.
  test("an allowlist without actor wins over the system-spawned exemption", () => {
    expect(actorToolVariant({ name: "distill", mode: "subagent", toolAllowlist: ["read", "memory"] })).toBe("none")
    expect(actorToolVariant({ name: "build", mode: "primary", toolAllowlist: ["read"] })).toBe("none")
  })

  test("hasActorTool means spawn-capable", () => {
    expect(hasActorTool({ name: "build", mode: "primary" })).toBe(true)
    expect(hasActorTool({ name: "general", mode: "subagent" })).toBe(false)
    expect(hasActorTool({ name: "distill", mode: "subagent", toolAllowlist: ["read"] })).toBe(false)
    expect(hasActorTool(undefined)).toBe(true)
  })
})
