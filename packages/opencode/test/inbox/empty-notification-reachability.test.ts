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
import { shellWrap } from "../../src/tool/shell-wrap"
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

// Reachability probe for the body-less `actor_notification` inbox row — the
// suspected producer of `messages.<N>: user messages must have non-empty content`.
//
// test/inbox/empty-notification-part.test.ts proves what happens ONCE such a row
// exists (renderInboxRow → drain → a `text: ""` part). It calls Inbox.send
// directly, so it does NOT establish that any caller can supply an empty body.
// This file closes that gap at the only entry point that takes both `content`
// and `type` from the model: the `actor` tool's `send` action.
//
// The decisive case is `via the real shellWrap route` below. Driving
// `def.execute` directly is NOT a substitute: it presupposes the very question
// (does the shell route reach the wrap-decorated execute?). The real composition
// is `shellWrap(Tool.init(actor))` — registry.ts wires `actor: Tool.init(actor)`
// (the wrap-decorated def, see tool.ts `define` → `wrap`) into `s.builtin`,
// `all()`/`available()` only filter that array, and registry.ts then applies
// `shellWrap` to that same object. So `shell-wrap.ts`'s `def.execute(parsed)` is
// the wrap-decorated execute, and `wrap()` runs `toolInfo.parameters.parse(args)`
// on the shell-parsed op. A shell-mode op IS re-validated.
//
// Consequence, established by a revert probe on this file (drop the
// parseActorScript guard in src/tool/actor.ts and re-run): the shell route still
// enqueues nothing, because `content: z.string().min(1)` fails closed. The
// parse-level guard is therefore a message-quality improvement (a specific,
// teachable error instead of a generic zod dump), NOT the layer that makes a
// blank body unreachable. An empty `actor_notification` body was never reachable
// through the tool, so the render.ts/drain fixes in this PR close a LATENT
// defence gap rather than a live producer.

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

const rowsFor = (sessionID: SessionID, actorID: string) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(InboxTable)
        .where(and(eq(InboxTable.receiver_session_id, sessionID), eq(InboxTable.receiver_actor_id, actorID)))
        .all(),
    ),
  )

describe("empty actor_notification body: reachability", () => {
  it.live(
    'the shell-parsed `actor send <id> ""` is rejected by parseActorScript',
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(parseActorScript('actor send main "" --type actor_notification'))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  // DECISIVE CASE. Exercises the production composition end-to-end:
  // shellWrap(wrap-decorated actor def).execute({ script }). No inbox row may be
  // written for a blank body. Revert the parseActorScript guard and this still
  // passes — which is what proves zod, not the parse guard, is load-bearing.
  it.live(
    'via the real shellWrap route, `actor send <id> ""` enqueues nothing',
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const actorID = yield* registerActor(chat.id)

        const def = yield* Effect.flatMap(ActorTool, (tool) => tool.init())
        const shell = shellWrap({ ...def, id: "actor" })

        const exit = yield* Effect.exit(
          shell.execute({ script: `actor send ${actorID} ""` }, ctxFor(chat.id) as never),
        )
        // shell-wrap converts a per-command failure into a *successful* result
        // carrying an error report, so assert on the observable side effect
        // rather than the exit tag: nothing may be enqueued.
        expect(yield* rowsFor(chat.id, actorID)).toHaveLength(0)
        if (exit._tag === "Success") {
          expect(exit.value.output).not.toContain("inboxID")
        }
      }),
    ),
  )

  it.live(
    "the operation-level zod min(1) rejects an empty body inside def.execute",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const actorID = yield* registerActor(chat.id)

        const def = yield* Effect.flatMap(ActorTool, (tool) => tool.init())

        // Hand def.execute the exact op a shell-parsed call would produce.
        // wrap()'s parameters.parse must reject it.
        const exit = yield* Effect.exit(
          def.execute(
            { operation: { action: "send", to_actor_id: actorID, content: "", type: "actor_notification" } },
            ctxFor(chat.id),
          ),
        )
        expect(exit._tag).toBe("Failure")
        expect(yield* rowsFor(chat.id, actorID)).toHaveLength(0)
      }),
    ),
  )

  it.live(
    "a non-empty body still goes through the shell route, so the guards are not over-broad",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const actorID = yield* registerActor(chat.id)

        const def = yield* Effect.flatMap(ActorTool, (tool) => tool.init())
        const shell = shellWrap({ ...def, id: "actor" })
        const result = yield* shell.execute(
          { script: `actor send ${actorID} "real body"` },
          ctxFor(chat.id) as never,
        )
        expect(result.output).toContain("inboxID")
        expect(yield* rowsFor(chat.id, actorID)).toHaveLength(1)
      }),
    ),
  )
})
