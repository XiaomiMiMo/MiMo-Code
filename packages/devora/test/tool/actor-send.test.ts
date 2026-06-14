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
import { MessageID, type SessionID } from "../../src/session/schema"
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
        const parsed = JSON.parse(result.output) as { inboxID: string }
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
      }),
    ),
  )

  it.live(
    "send to missing actor returns structured error without throwing",
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

        const parsed = JSON.parse(result.output) as { inboxID: string }
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
