import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Plugin } from "../../src/plugin"
import { Agent } from "../../src/agent/agent"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { Log } from "../../src/util"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { resolveCurrentAgent } from "../../src/server/routes/instance/session"

void Log.init({ print: false })

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

// Session.create needs ChildProcessSpawner; mirror prune-main-slice/checkpoint-main-slice
// layer wiring so the harness path is identical — only the scenario differs.
const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  deps,
)

const it = testEffect(env)

// Regression for the summarize HTTP route's currentAgent lookup. The handler
// previously walked the unfiltered message stream newest-first to pick the
// agent identity that drives compact.create. With subagents on the same
// sessionID, a checkpoint-writer's task user message at the tail flips
// currentAgent to the subagent — the server-side compaction then runs against
// the wrong prompt/tools. The fix pins the lookup to the main slice via the
// resolveCurrentAgent helper.
describe("summarize route — currentAgent lookup uses main slice", () => {
  it.live(
    "ignores trailing subagent user messages when picking currentAgent",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        // Main user message: agent="build". This is the identity the
        // summarize route should resolve to.
        const mainID = MessageID.ascending()
        yield* ssn.updateMessage({
          id: mainID,
          role: "user" as const,
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: mainID,
          sessionID: info.id,
          type: "text",
          text: "user prompt",
        })

        // Subagent user message at the tail. Without the main-slice pin,
        // newest-first iteration picks this row up and currentAgent becomes
        // "checkpoint-writer".
        const subID = MessageID.ascending()
        yield* ssn.updateMessage({
          id: subID,
          role: "user" as const,
          sessionID: info.id,
          agentID: "checkpoint-writer-1",
          agent: "checkpoint-writer",
          model: ref,
          time: { created: Date.now() + 1 },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: subID,
          sessionID: info.id,
          type: "text",
          text: "checkpoint task body",
        })

        const got = yield* resolveCurrentAgent(info.id, "build")
        expect(got).toBe("build")
      }),
    ),
  )
})
