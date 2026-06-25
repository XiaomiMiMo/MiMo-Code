import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ToolRegistry } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
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

// [S6]: the `session` tool is orchestrator-only. The orchestrator agent lists
// "session" in its toolAllowlist (so the allowlist filter keeps it). build/plan/
// compose have NO allowlist — they receive ALL builtins, so an explicit gate in
// ToolRegistry.tools drops "session" for them. These two assertions pin both
// halves of that gate.
describe("ToolRegistry.tools: session tool orchestrator gating", () => {
  it.live("orchestrator sees the session tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const orchestrator = yield* agents.get("orchestrator")
        if (!orchestrator) throw new Error("no orchestrator agent")
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("opencode/claude-sonnet-4-6"),
          agent: orchestrator,
        })
        expect(tools.map((t) => t.id)).toContain("session")
      }),
    ),
  )

  it.live("build does NOT see the session tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        if (!build) throw new Error("no build agent")
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("opencode/claude-sonnet-4-6"),
          agent: build,
        })
        expect(tools.map((t) => t.id)).not.toContain("session")
      }),
    ),
  )
})
