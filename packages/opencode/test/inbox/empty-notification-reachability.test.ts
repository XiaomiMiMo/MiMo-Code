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
import { ActorTool, parseActorScript } from "../../src/tool/actor"
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

// Reachability probe for the body-less `actor_notification` inbox row, the
// suspected producer of `messages.<N>: user messages must have non-empty content`.
//
// test/inbox/empty-notification-part.test.ts proves what happens ONCE such a row
// exists (renderInboxRow → drain → a `text: ""` part). It calls Inbox.send
// directly, so it does NOT establish that any caller can actually supply an
// empty body. This file closes that gap from the only entry point that takes
// both `content` and `type` from the model: the `actor` tool's `send` action.
//
// Two independent layers block it, and they fail differently:
//   1. parseActorScript rejects an empty body on the shell-parsed path
//      (`actor send <id> "" --type actor_notification`);
//   2. the operation-level zod schema (`content: z.string().min(1)`), which
//      Tool.define's wrap() applies to `args` INSIDE def.execute — so a
//      shell-parsed op IS re-validated, contrary to what the comment on the
//      layer-1 guard claims.
//
// VERDICT: layer 2 alone is sufficient and predates layer 1, so an empty
// `actor_notification` body was never reachable through the tool. Every other
// writer of an `actor_notification` row builds its body from a non-empty
// template (renderActorNotification, workflow/runtime.ts), and every `type:
// "text"` row is wrapped in a non-empty `<inbox>` envelope by renderInboxRow.
// The `??` → `||` change in src/inbox/render.ts therefore closes a LATENT
// defence gap, not a live producer. Layer 1 stays as defence in depth: it turns
// a generic zod rejection into a specific, teachable message, and it would be
// the only guard left if the schema were ever relaxed.

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
    ActorWaiter.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(ActorRegistry.defaultLayer),
      Layer.provide(Session.defaultLayer),
    ),
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

const registerActor = Effect.fn(function* (sessionID: SessionID) {
  const registry = yield* ActorRegistry.Service
  const actorID = yield* registry.allocateActorID(sessionID, "general")
  yield* registry.register({
    sessionID,
    actorID,
    mode: "subagent",
    agent: "general",
    description: "reachability probe",
    contextMode: "none",
    background: true,
    lifecycle: "ephemeral",
  })
  yield* registry.updateStatus(sessionID, actorID, { status: "running" })
  return actorID
})

describe("empty actor_notification body: reachability", () => {
  it.live(
    "the shell-parsed `actor send <id> \"\"` is rejected before it can reach Inbox.send",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(parseActorScript('actor send main "" --type actor_notification'))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "the operation-level zod min(1) also rejects an empty body inside def.execute",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const actorID = yield* registerActor(chat.id)

        const def = yield* Effect.flatMap(ActorTool, (tool) => tool.init())

        // Bypass the shell parser entirely and hand def.execute the exact op a
        // shell-parsed call would have produced. wrap()'s parameters.parse must
        // reject it, so an empty body cannot reach Inbox.send by this route either.
        const exit = yield* Effect.exit(
          def.execute(
            { operation: { action: "send", to_actor_id: actorID, content: "", type: "actor_notification" } },
            ctxFor(chat.id),
          ),
        )
        expect(exit._tag).toBe("Failure")

        // And nothing was enqueued.
        const rows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(InboxTable)
              .where(and(eq(InboxTable.receiver_session_id, chat.id), eq(InboxTable.receiver_actor_id, actorID)))
              .all(),
          ),
        )
        expect(rows).toHaveLength(0)
      }),
    ),
  )

  it.live(
    "a non-empty body still goes through, so the guards are not over-broad",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const actorID = yield* registerActor(chat.id)

        const def = yield* Effect.flatMap(ActorTool, (tool) => tool.init())
        const result = yield* def.execute(
          { operation: { action: "send", to_actor_id: actorID, content: "real body", type: "actor_notification" } },
          ctxFor(chat.id),
        )
        expect((JSON.parse(result.output) as { inboxID: string }).inboxID).toBeTruthy()
      }),
    ),
  )
})
