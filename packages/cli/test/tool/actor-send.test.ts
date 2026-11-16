import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Provider } from "../../src/provider"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { Database, and, eq } from "../../src/storage"
import { MessageID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { ActorTool } from "../../src/tool/actor"
import { ActorRegistry } from "../../src/actor/registry"
import { TaskRegistry } from "../../src/task/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { Inbox } from "../../src/inbox"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { Team } from "../../src/team"
import { Truncate } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const inboxDeps = Layer.mergeAll(Bus.layer, ActorRegistry.defaultLayer, Session.defaultLayer)

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Bus.layer,
    Config.defaultLayer,
    Provider.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    ActorRegistry.defaultLayer,
    ActorWaiter.layer.pipe(Layer.provide(Bus.layer), Layer.provide(ActorRegistry.defaultLayer), Layer.provide(Session.defaultLayer)),
    Team.defaultLayer,
    SessionCheckpoint.defaultLayer,
    TaskRegistry.defaultLayer,
    Inbox.layer.pipe(Layer.provide(inboxDeps)),
  ),
)

function ctxFor(sessionID: SessionID) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    extra: {},
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("actor tool — send action", () => {
  it.live(
    "send to existing actor writes a row in the inbox table",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const registry = yield* ActorRegistry.Service
        const chat = yield* sessions.create({ title: "chat" })

        const actorID = yield* registry.allocateActorID(chat.id, "general")
        yield* registry.register({
          sessionID: chat.id,
          actorID,
          mode: "subagent",
          agent: "general",
          description: "explore task",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(chat.id, actorID, { status: "running" })

        const tool = yield* ActorTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            operation: {
              action: "send",
              to_actor_id: actorID,
              content: "hello actor",
            },
          },
          ctxFor(chat.id),
        )

        // Tool result: success shape
        const parsed = JSON.parse(result.output) as { inboxID: string; inputMessageID: string }
        expect(parsed.inboxID).toBeTruthy()
        expect(result.title).toBe(`Sent to ${actorID}`)

        // Verify row landed in inbox table for this receiver
        const rows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(InboxTable)
              .where(and(eq(InboxTable.receiver_session_id, chat.id), eq(InboxTable.receiver_actor_id, actorID)))
              .all(),
          ),
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].id).toBe(parsed.inboxID)
        expect(String(rows[0].input_message_id)).toBe(parsed.inputMessageID)
        expect(rows[0].content).toBeNull()
        const message = MessageV2.get({ sessionID: chat.id, messageID: rows[0].input_message_id! })
        expect(message.parts).toEqual([expect.objectContaining({ type: "text", synthetic: true, text: expect.stringContaining("hello actor") })])
      }),
    ),
  )

  it.live(
    "cross-session send to missing receiver returns structured error without throwing",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })

        const tool = yield* ActorTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            operation: {
              action: "send",
              to_actor_id: "does-not-exist",
              to_session_id: SessionID.descending(),
              content: "hello nobody",
            },
          },
          ctxFor(chat.id),
        )

        // Does NOT throw — receiver-not-found is surfaced as a structured tool result
        const parsed = JSON.parse(result.output) as { inboxID: string | null; error: string }
        expect(parsed.inboxID).toBeNull()
        expect(parsed.error).toBe("receiver not found")
        expect(result.title).toContain("receiver not found")
      }),
    ),
  )

  it.live(
    "send without to_session_id defaults to current session",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const registry = yield* ActorRegistry.Service
        const chat = yield* sessions.create({ title: "chat" })

        const actorID = yield* registry.allocateActorID(chat.id, "general")
        yield* registry.register({
          sessionID: chat.id,
          actorID,
          mode: "subagent",
          agent: "general",
          description: "target actor",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })

        const tool = yield* ActorTool
        const def = yield* tool.init()
        // Omit to_session_id — should default to ctx.sessionID (chat.id)
        const result = yield* def.execute(
          {
            operation: {
              action: "send",
              to_actor_id: actorID,
              content: "default session test",
            },
          },
          ctxFor(chat.id),
        )

        const parsed = JSON.parse(result.output) as { inboxID: string; inputMessageID: string }
        expect(parsed.inboxID).toBeTruthy()

        // Row is on the current session (chat.id), not some other session
        const rows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(InboxTable)
              .where(and(eq(InboxTable.receiver_session_id, chat.id), eq(InboxTable.receiver_actor_id, actorID)))
              .all(),
          ),
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].receiver_session_id).toBe(chat.id)
      }),
    ),
  )
})

// docs/compose/spec/subagent-model-follow.md T3 — a finished subagent woken by send re-resolves
// its model (explicit spawn model > agent config > target session's current main model); a running
// one keeps the model it started with.
describe("actor tool — send wake model", () => {
  const xiaomi = {
    enabled_providers: ["test", "xiaomi"],
    // The fixture catalog declares no effort levels for mimo-v2-pro; config offers "high".
    provider: { xiaomi: { options: { apiKey: "test-key" }, models: { "mimo-v2-pro": { variants: { high: {} } } } } },
  }
  const startModel = { providerID: "test", modelID: "test-model" }

  type Model = { providerID: string; modelID: string; variant?: string }
  const userMessage = (sessionID: SessionID, model: Model, agentID?: string) =>
    Effect.gen(function* () {
      yield* (yield* Session.Service).updateMessage({
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: agentID ? "general" : "build",
        ...(agentID ? { agentID } : {}),
        model: model as MessageV2.User["model"],
      } as MessageV2.User)
    })

  /**
   * Subagent that ran on `startModel`, then the main lane moved to `mainModel`; send wakes it.
   * `parentModel` registers a parent actor whose lane ran on that model and makes it the child's
   * `parentActorID`; `crossSession` sends from another session via `to_session_id`.
   */
  const wake = (input: {
    status: "idle" | "running"
    mainModel: Model
    agent?: string
    modelRef?: string
    parentModel?: Model
    crossSession?: boolean
  }) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "chat" })
      const registry = yield* ActorRegistry.Service
      const subagent = (agent: string, extra: { parentActorID?: string; modelRef?: string }) =>
        Effect.gen(function* () {
          const actorID = yield* registry.allocateActorID(chat.id, agent)
          yield* registry.register({
            sessionID: chat.id,
            actorID,
            mode: "subagent",
            agent,
            description: agent,
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
            ...extra,
          })
          return actorID
        })
      const parentActorID = input.parentModel ? yield* subagent("general", {}) : undefined
      const actorID = yield* subagent(input.agent ?? "general", {
        ...(parentActorID ? { parentActorID } : {}),
        ...(input.modelRef ? { modelRef: input.modelRef } : {}),
      })
      yield* registry.updateStatus(chat.id, actorID, { status: input.status })
      yield* userMessage(chat.id, startModel)
      if (parentActorID) yield* userMessage(chat.id, input.parentModel!, parentActorID)
      yield* userMessage(chat.id, startModel, actorID)
      yield* userMessage(chat.id, input.mainModel)

      const sender = input.crossSession ? (yield* sessions.create({ title: "sender" })).id : chat.id
      const def = yield* (yield* ActorTool).init()
      const result = yield* def.execute(
        {
          operation: {
            action: "send",
            to_actor_id: actorID,
            content: "follow up",
            ...(input.crossSession ? { to_session_id: chat.id } : {}),
          },
        },
        ctxFor(sender),
      )
      const parsed = JSON.parse(result.output) as { inputMessageID: string }
      const info = MessageV2.get({ sessionID: chat.id, messageID: MessageID.make(parsed.inputMessageID) }).info
      return info.role === "user" ? (info.model as Model) : undefined
    })

  // [TP-RUN-R13-01] (MiMo Desktop turn-execution)
  it.live(
    "finished subagent without its own model follows the current main model and variant",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const model = yield* wake({ status: "idle", mainModel: { providerID: "test", modelID: "other", variant: "high" } })
        expect(model).toEqual({ providerID: "test", modelID: "other", variant: "high" })
      }),
    ),
  )

  // [TP-RUN-R13-02] (MiMo Desktop turn-execution)
  it.live(
    "running subagent keeps the model it started with",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const model = yield* wake({ status: "running", mainModel: { providerID: "test", modelID: "other", variant: "high" } })
        expect(model).toEqual(startModel)
      }),
    ),
  )

  // [TP-RUN-R13-04] (MiMo Desktop turn-execution)
  it.live(
    "explicit spawn model is kept and inherits the main variant only when offered",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const modelRef = "xiaomi/mimo-v2-pro"
          expect(yield* wake({ status: "idle", modelRef, mainModel: { ...startModel, variant: "high" } })).toEqual({
            providerID: "xiaomi",
            modelID: "mimo-v2-pro",
            variant: "high",
          })
          expect(yield* wake({ status: "idle", modelRef, mainModel: { ...startModel, variant: "max" } })).toEqual({
            providerID: "xiaomi",
            modelID: "mimo-v2-pro",
          })
        }),
      { config: xiaomi },
    ),
  )

  // [TP-RUN-R13-04] (MiMo Desktop turn-execution)
  it.live(
    "agent with its own configured model keeps it",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const model = yield* wake({ status: "idle", agent: "tuned", mainModel: { providerID: "test", modelID: "other" } })
          expect(model).toEqual({ providerID: "xiaomi", modelID: "mimo-v2-pro" })
        }),
      { config: { ...xiaomi, agent: { tuned: { description: "Tuned", mode: "subagent", model: "xiaomi/mimo-v2-pro" } } } },
    ),
  )

  // [TP-RUN-R13-05] (MiMo Desktop turn-execution)
  it.live(
    "explicit model that no longer resolves falls back to the subagent's last model",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const model = yield* wake({ status: "idle", modelRef: "gone/missing", mainModel: { providerID: "test", modelID: "other" } })
        expect(model).toEqual(startModel)
      }),
    ),
  )

  // [TP-RUN-R13-01] (MiMo Desktop turn-execution)
  it.live(
    "a subagent with a parent actor follows the parent lane, not the main lane",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const model = yield* wake({
          status: "idle",
          parentModel: { providerID: "test", modelID: "parent-model", variant: "low" },
          mainModel: { providerID: "test", modelID: "other", variant: "high" },
        })
        expect(model).toEqual({ providerID: "test", modelID: "parent-model", variant: "low" })
      }),
    ),
  )

  // [TP-RUN-R13-01] (MiMo Desktop turn-execution)
  it.live(
    "a cross-session wake follows the target session's main lane",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const model = yield* wake({ status: "idle", crossSession: true, mainModel: { providerID: "test", modelID: "other" } })
        expect(model).toEqual({ providerID: "test", modelID: "other" })
      }),
    ),
  )

  // [TP-RUN-R13-04] (MiMo Desktop turn-execution)
  it.live(
    "an agent's own variant on its configured model survives the wake",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const model = yield* wake({ status: "idle", agent: "tuned", mainModel: { providerID: "test", modelID: "other", variant: "max" } })
          expect(model).toEqual({ providerID: "xiaomi", modelID: "mimo-v2-pro", variant: "high" })
        }),
      { config: { ...xiaomi, agent: { tuned: { description: "Tuned", mode: "subagent", model: "xiaomi/mimo-v2-pro", variant: "high" } } } },
    ),
  )

  // [TP-RUN-R13-02] (MiMo Desktop turn-execution) the idle check and the write are one admission
  // step: a candidate wake model reaching a lane that is already running is not applied.
  it.live(
    "Inbox applies the wake model only while the receiver is still idle at admission",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const chat = yield* (yield* Session.Service).create({ title: "chat" })
        const registry = yield* ActorRegistry.Service
        const inbox = yield* Inbox.Service
        const actorID = yield* registry.allocateActorID(chat.id, "general")
        yield* registry.register({
          sessionID: chat.id,
          actorID,
          mode: "subagent",
          agent: "general",
          description: "child",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* userMessage(chat.id, startModel, actorID)
        const idleModel = { providerID: "test", modelID: "other" } as MessageV2.User["model"]
        const acceptWith = () =>
          Effect.gen(function* () {
            const { inputMessageID } = yield* inbox.accept({ receiverSessionID: chat.id, receiverActorID: actorID, content: "x", idleModel })
            const info = MessageV2.get({ sessionID: chat.id, messageID: inputMessageID }).info
            return info.role === "user" ? (info.model as Model) : undefined
          })

        yield* registry.updateStatus(chat.id, actorID, { status: "running" })
        expect(yield* acceptWith()).toEqual(startModel)
        yield* registry.updateStatus(chat.id, actorID, { status: "idle" })
        expect(yield* acceptWith()).toEqual({ providerID: "test", modelID: "other" })
      }),
    ),
  )
})
