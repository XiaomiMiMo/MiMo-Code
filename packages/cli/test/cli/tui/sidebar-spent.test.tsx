/** @jsxImportSource @opentui/solid */
import { expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { Effect, Layer } from "effect"
import { ContextSidebar } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/context"
import { bucketMessages } from "../../../src/cli/cmd/tui/context/sync"
import { createTuiApi } from "../../../src/cli/cmd/tui/plugin/api"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import * as CrossSpawnSpawner from "../../../src/effect/cross-spawn-spawner"
import { Session } from "../../../src/session"
import { MessageV2 } from "../../../src/session/message-v2"
import { MessageID, type SessionID } from "../../../src/session/schema"
import { provideTmpdirInstance } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { testEffect } from "../../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

function seed(sessionID: SessionID, agentID: string, costs: number[]) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const parentID = MessageID.ascending()
    const child = agentID !== "main"
    yield* sessions.updateMessage({
      id: parentID,
      sessionID,
      agentID,
      role: "user",
      time: { created: 1 },
      agent: "test",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("model") },
    })
    for (const [index, cost] of costs.entries()) {
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        parentID,
        sessionID,
        agentID,
        role: "assistant",
        agent: "test",
        mode: "default",
        modelID: ModelID.make(child ? "other" : "model"),
        providerID: ProviderID.make("test"),
        path: { cwd: "/tmp/example", root: "/tmp/example" },
        time: { created: 1_000 + index * 1_000, completed: 2_000 + index * 1_000 },
        cost,
        tokens: { input: child ? 10_000 : 100, output: child ? 100 : 5, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    }
  })
}

async function sidebar(sessionID: SessionID, messages: MessageV2.Info[], cost: number) {
  const fixture = createTuiPluginApi()
  const input = {
    sync: {
      data: {
        config: {},
        provider: [
          {
            id: "test",
            models: {
              model: {
                id: "model",
                providerID: "test",
                api: { id: "model", npm: "@ai-sdk/openai" },
                limit: { context: 1_000, input: 1_000, output: 100 },
              },
              other: {
                id: "other",
                providerID: "test",
                api: { id: "other", npm: "@ai-sdk/openai" },
                limit: { context: 100_000, input: 100_000, output: 10_000 },
              },
            },
          },
        ],
        message: { [sessionID]: bucketMessages(messages) },
        session_cost: { [sessionID]: cost },
      },
    },
    theme: { theme: fixture.theme.current },
  }
  // @ts-expect-error This rendering fixture supplies only the state and theme consumed by the sidebar.
  const api = createTuiApi(input)
  const app = await testRender(() => <ContextSidebar api={api} session_id={sessionID} />)
  try {
    await app.renderOnce()
    return {
      frame: app.captureCharFrame(),
      agentIDs: api.state.session.messages(sessionID).map((message) => message.agentID),
    }
  } finally {
    app.renderer.destroy()
  }
}

it.live("sidebar spending includes persisted subagent costs without changing its message list", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      yield* seed(session.id, "main", [1])
      yield* seed(session.id, "general-1", [2])
      const messages = yield* sessions.messages({ sessionID: session.id, agentID: "*" })
      const cost = yield* sessions.cost(session.id)
      const view = yield* Effect.promise(() =>
        sidebar(
          session.id,
          messages.map((message) => message.info),
          cost,
        ),
      )

      expect(view.frame).toContain("$3.00 spent")
      expect(view.frame).toContain("105 tokens")
      expect(view.frame).toContain("11% used")
      expect(view.frame).toContain("5 t/s")
      expect(view.agentIDs).toEqual(["main", "main"])
    }),
  ),
)

it.live("sidebar spending includes costs outside the 100-message opening page", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      yield* seed(
        session.id,
        "main",
        Array.from({ length: 101 }, () => 1),
      )
      const page = MessageV2.page({ sessionID: session.id, agentID: "*", limit: 100 })
      const cost = yield* sessions.cost(session.id)
      const view = yield* Effect.promise(() =>
        sidebar(
          session.id,
          page.items.map((message) => message.info),
          cost,
        ),
      )

      expect(page.more).toBe(true)
      expect(view.frame).toContain("$101.00 spent")
    }),
  ),
)
