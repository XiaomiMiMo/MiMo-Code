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
import { MessageID, SessionID } from "../../src/session/schema"
import { ActorTool } from "../../src/tool/actor"
import { ActorRegistry } from "../../src/actor/registry"
import { TaskRegistry } from "../../src/task/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { Team } from "../../src/team"
import { Truncate } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

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
  ),
)

interface WaitResponse {
  status: string
  actor_id: string
  result?: string
  error?: string
}

function parseOutput(output: string): WaitResponse {
  return JSON.parse(output) as WaitResponse
}

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

describe("actor tool — wait action", () => {
  it.live(
    "wait on already-completed task returns immediately",
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
          description: "done",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(chat.id, actorID, { status: "idle", lastOutcome: "success" })

        const tool = yield* ActorTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          { operation: { action: "wait", actor_id: actorID } },
          ctxFor(chat.id),
        )

        const snap = parseOutput(result.output)
        expect(snap.status).toBe("idle")
        expect(snap.actor_id).toBe(actorID)
      }),
    ),
  )

  it.live(
    "wait on subagent of another session returns 'unknown' (parent ownership)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const registry = yield* ActorRegistry.Service
        const chatA = yield* sessions.create({ title: "chatA" })
        const chatB = yield* sessions.create({ title: "chatB" })
        const actorID = yield* registry.allocateActorID(chatA.id, "general")
        yield* registry.register({
          sessionID: chatA.id,
          actorID,
          mode: "subagent",
          agent: "general",
          description: "A's task",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(chatA.id, actorID, { status: "idle", lastOutcome: "success" })

        const tool = yield* ActorTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          { operation: { action: "wait", actor_id: actorID } },
          ctxFor(chatB.id),
        )

        const snap = parseOutput(result.output)
        expect(snap.status).toBe("unknown")
        expect(snap.actor_id).toBe(actorID)
      }),
    ),
  )

  it.live(
    "wait with short timeout on pending task returns 'timeout'",
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
          description: "slow",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })

        const tool = yield* ActorTool
        const def = yield* tool.init()
        const start = Date.now()
        const result = yield* def.execute(
          { operation: { action: "wait", actor_id: actorID, timeout_ms: 150 } },
          ctxFor(chat.id),
        )
        const elapsed = Date.now() - start

        const snap = parseOutput(result.output)
        expect(snap.status).toBe("timeout")
        expect(elapsed).toBeGreaterThanOrEqual(140)
        expect(elapsed).toBeLessThan(2000)
      }),
    ),
  )

  it.live(
    "wait missing actor_id fails",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const tool = yield* ActorTool
        const def = yield* tool.init()

        const result = yield* def
          // cast: the schema rejects this shape at parse time; the cast is the
          // only way to drive that failure path through tool.execute() in tests.
          .execute({ operation: { action: "wait" } } as any, ctxFor(chat.id))
          .pipe(Effect.exit)

        expect(result._tag).toBe("Failure")
      }),
    ),
  )
})
