import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Plugin } from "../../src/plugin"
import { Agent } from "../../src/agent/agent"
import { ActorRegistry } from "../../src/actor/registry"
import { SessionPrune } from "../../src/session/prune"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { Session as SessionNs } from "../../src/session"
import { Provider } from "../../src/provider"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { Log } from "../../src/util"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

// Layer wiring mirrors test/session/prune.test.ts so the harness path is
// identical — only the seeding scenario differs.
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
  SessionPrune.layer.pipe(
    Layer.provide(SessionNs.defaultLayer),
    Layer.provide(SessionCheckpoint.defaultLayer),
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provideMerge(deps),
  ),
)

const it = testEffect(env)

function createModel(opts: { context: number; output: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

describe("SessionPrune.prune main-slice protect window", () => {
  it.live(
    "subagent user messages do not deflate main-slice 'last 2 turns' protection",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // Main: 1 user → 1 finished assistant carrying a completed bash
          // tool part with large output (a prune candidate). 2 subagent
          // user msgs on top. Under the buggy unfiltered path, the
          // subagent users push `turns` past the "last 2 turns" floor
          // before iteration reaches the main assistant — its bash output
          // gets pruned. With main-only filtering, the main asst stays
          // inside the protect window.
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const mainUserID = MessageID.ascending()
          yield* ssn.updateMessage({
            id: mainUserID,
            role: "user" as const,
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: mainUserID,
            sessionID: info.id,
            type: "text",
            text: "user prompt",
          })

          const mainAsstID = MessageID.ascending()
          yield* ssn.updateMessage({
            id: mainAsstID,
            role: "assistant" as const,
            sessionID: info.id,
            agentID: "main",
            agent: "build",
            mode: "primary",
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: mainUserID,
            time: { created: Date.now() + 1, completed: Date.now() - 86_400_000 /* old → cache-cold */ },
            finish: "end_turn",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            path: { cwd: dir, root: dir },
            cost: 0,
          })
          const toolPartID = PartID.ascending()
          yield* ssn.updatePart({
            id: toolPartID,
            messageID: mainAsstID,
            sessionID: info.id,
            type: "tool",
            tool: "bash",
            callID: crypto.randomUUID(),
            state: {
              status: "completed",
              input: { command: "echo hi" },
              output: "x".repeat(200_000),
              title: "done",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })

          // Two subagent users on top of main asst.
          for (let i = 0; i < 2; i++) {
            const id = MessageID.ascending()
            yield* ssn.updateMessage({
              id,
              role: "user" as const,
              sessionID: info.id,
              agentID: "explore-1",
              agent: "explore",
              model: ref,
              time: { created: Date.now() + 3 + i },
            })
            yield* ssn.updatePart({
              id: PartID.ascending(),
              messageID: id,
              sessionID: info.id,
              type: "text",
              text: `explore ${i}`,
            })
          }

          const prune = yield* SessionPrune.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          // pressure-based level requires tokens > 0; mimic prune.test.ts.
          const tokens = { input: 80_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          yield* prune.prune({
            sessionID: info.id,
            model,
            tokens,
            lastAssistantTime: Date.now() - 86_400_000,
          })

          // Main asst's bash tool part should NOT be marked compacted:
          // main slice's "last 2 turns" includes the main user + main
          // asst, so the tool stays inside the protect window.
          const reloaded = yield* ssn.messages({ sessionID: info.id, agentID: "main" })
          const mainAsstReloaded = reloaded.find((m) => m.info.id === mainAsstID)
          const toolPart = mainAsstReloaded?.parts.find((p) => p.id === toolPartID && p.type === "tool")
          expect(toolPart).toBeDefined()
          if (toolPart?.type === "tool" && toolPart.state.status === "completed") {
            expect(toolPart.state.time.compacted).toBeUndefined()
          }
        }),
      { config: { compaction: { prune: true } } },
    ),
  )

  it.live(
    "subagent user messages do not deflate main-slice 'last 3 turns' media protect window",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // Main: user(image) → asst ×5. Under the buggy unfiltered default,
          // 3 subagent users on top push turnCount past 3 BEFORE iteration
          // reaches u4, so boundary lands inside the main slice and u0..u3's
          // images all get stripped. With main-only filtering, boundary
          // lands at u1, so only u0's image is stripped — u1..u4 stay safe.
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const mainImagePartIDs: string[] = []
          for (let i = 0; i < 5; i++) {
            const uid = MessageID.ascending()
            yield* ssn.updateMessage({
              id: uid,
              role: "user" as const,
              sessionID: info.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() - 86_400_000 + i * 2 /* old → cache-cold */ },
            })
            const imgID = PartID.ascending()
            yield* ssn.updatePart({
              id: imgID,
              messageID: uid,
              sessionID: info.id,
              type: "file",
              mime: "image/png",
              url: "data:image/png;base64,AAAA",
              filename: `pic-${i}.png`,
            })
            mainImagePartIDs.push(imgID)

            const aid = MessageID.ascending()
            yield* ssn.updateMessage({
              id: aid,
              role: "assistant" as const,
              sessionID: info.id,
              agentID: "main",
              agent: "build",
              mode: "primary",
              modelID: ref.modelID,
              providerID: ref.providerID,
              parentID: uid,
              time: { created: Date.now() - 86_400_000 + i * 2 + 1, completed: Date.now() - 86_400_000 + i * 2 + 2 },
              finish: "end_turn",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              path: { cwd: dir, root: dir },
              cost: 0,
            })
          }
          // 3 subagent users on top.
          for (let i = 0; i < 3; i++) {
            const id = MessageID.ascending()
            yield* ssn.updateMessage({
              id,
              role: "user" as const,
              sessionID: info.id,
              agentID: "explore-1",
              agent: "explore",
              model: ref,
              time: { created: Date.now() + 100 + i },
            })
          }

          const prune = yield* SessionPrune.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          // Heavy tokens drive level >= 2 → stripNonEssential fires.
          const tokens = { input: 95_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          yield* prune.prune({
            sessionID: info.id,
            model,
            tokens,
            lastAssistantTime: Date.now() - 86_400_000,
          })

          const reloaded = yield* ssn.messages({ sessionID: info.id, agentID: "main" })
          // u1..u4's images MUST still have their real URL — under the buggy
          // unfiltered path they would all be stripped to "".
          for (let i = 1; i < 5; i++) {
            const id = mainImagePartIDs[i]
            const found = reloaded.flatMap((m) => m.parts).find((p) => p.id === id)
            expect(found).toBeDefined()
            expect((found as { url: string }).url).toMatch(/^data:image/)
          }
        }),
      { config: { compaction: { prune: true } } },
    ),
  )
})
