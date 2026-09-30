import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Plugin } from "../../src/plugin"
import { Agent } from "../../src/agent/agent"
import { Session as SessionNs } from "../../src/session"
import { Provider } from "../../src/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { ActorRegistry } from "../../src/actor/registry"
import * as Actor from "../../src/actor/spawn"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { forkQuery } from "../../src/tool/session"

void Log.init({ print: false })

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  ActorRegistry.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  TestLLMServer.layer,
  Actor.defaultLayer,
  deps,
)

const it = testEffect(env)

const askProviderCfg = (url: string) => ({
  provider: {
    test: {
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

// The POST /:sessionID/ask route is a thin wrapper over forkQuery (frozen
// snapshot, read-only fork). These tests cover the no-activity early return and
// the real LLM-backed paths that used to live in the deleted session-tool suite.
describe("forkQuery (backing the /:sessionID/ask route)", () => {
  it.live(
    "returns a graceful answer for a session with no activity",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const provider = yield* Provider.Service
        const info = yield* sessions.create({})

        const answer = yield* forkQuery(
          // actor is never reached on the no-activity path; the early return
          // fires before any spawn, so a stub interface is sufficient here.
          { sessions, provider, actor: {} as never },
          info.id,
          "what is this session about?",
        )

        expect(answer).toContain("no activity")
      }),
    ),
  )

  it.live(
    "spawns a READ-ONLY fork over a target with main-slice history and returns its answer",
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* SessionNs.Service
        const provider = yield* Provider.Service
        const actorReg = yield* ActorRegistry.Service
        const actor = yield* Actor.Service

        const target = yield* sessions.create({
          title: "Target with history",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID: target.id,
          agentID: "main",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        } as unknown as MessageV2.Info)

        yield* llm.text("The session is setting up a login page.")

        const answer = yield* forkQuery(
          { sessions, provider, actor },
          target.id,
          "what is this session doing?",
          { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        )

        // Must be the real answer text, not a non-empty failure string like
        // "(fork-query failed: …)" — those also satisfy length > 0.
        expect(answer).toContain("The session is setting up a login page.")
        expect(answer).not.toContain("no activity yet")
        expect(answer).not.toContain("(fork-query failed")

        const children = yield* sessions.children(target.id)
        expect(children.length).toBe(1)

        const forkActor = (yield* actorReg.listBySession(children[0].id)).find((a) => a.mode === "subagent")
        expect(forkActor).toBeDefined()
        const forkTools = forkActor!.tools
        expect(forkTools).toEqual(["read", "grep", "glob"])
        for (const banned of ["write", "edit", "bash", "apply_patch", "notebook_edit"]) {
          expect(forkTools).not.toContain(banned)
        }
      }),
      { git: true, config: askProviderCfg },
    ),
    60000,
  )

  it.live(
    "answers from a peer child's own-session slice (no false no-activity)",
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* SessionNs.Service
        const provider = yield* Provider.Service
        const actor = yield* Actor.Service

        const target = yield* sessions.create({
          title: "Peer child with history",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        // History lives under agent_id === target.id (the peer's own slice);
        // the "main" slice is left empty on purpose.
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID: target.id,
          agentID: target.id,
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        } as unknown as MessageV2.Info)

        yield* llm.text("The child read the config and is wiring the login route.")

        const answer = yield* forkQuery(
          { sessions, provider, actor },
          target.id,
          "what did you find?",
          { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        )

        // Must be the real answer text, not a non-empty failure string.
        expect(answer).toContain("The child read the config and is wiring the login route.")
        expect(answer).not.toContain("no activity yet")
        expect(answer).not.toContain("(fork-query failed")
        const children = yield* sessions.children(target.id)
        expect(children.length).toBe(1)
      }),
      { git: true, config: askProviderCfg },
    ),
    60000,
  )
})
