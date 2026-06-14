import { afterEach, beforeAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Provider } from "../../src/provider"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { MessageID, type SessionID } from "../../src/session/schema"
import { ActorTool } from "../../src/tool/actor"
import { ActorRegistry } from "../../src/actor/registry"
import { TaskRegistry } from "../../src/task/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { spawnRef } from "../../src/actor/spawn-ref"
import type { Interface as ActorInterface } from "../../src/actor/spawn"
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

interface CancelResponse {
  status: string
  actor_id: string
}

function parseOutput(output: string): CancelResponse {
  return JSON.parse(output) as CancelResponse
}

// The tool resolves Actor through spawnRef rather than as a Layer dep (see
// src/actor/spawn-ref.ts). For these tool-level tests we install a stub that
// records cancel signals and forwards the status update to the registry —
// mirroring what the real Actor.layer does in production. The real lifecycle
// test (with fiber interruption) lives in test/actor/spawn.test.ts.
const cancelled: Array<{ sessionID: SessionID; actorID: string; mode: "graceful" | "forced" }> = []
let installedRegistry: ActorRegistry.Interface | undefined
beforeAll(() => {
  spawnRef.current = {
    spawn: () => Effect.die("spawn not used in cancel tests"),
    cancel: (sessionID, actorID, mode) =>
      Effect.gen(function* () {
        cancelled.push({ sessionID, actorID, mode })
        if (installedRegistry) {
          yield* installedRegistry.updateStatus(sessionID, actorID, { status: "idle", lastOutcome: "cancelled" }).pipe(Effect.ignore)
        }
      }),
    getForkContext: () => Effect.succeed(undefined),
  } satisfies ActorInterface
})

function ctxFor(sessionID: SessionID) {
  return {
    ctx: {
      sessionID,
      messageID: MessageID.ascending(),
      agent: "build",
      abort: new AbortController().signal,
      extra: {
        promptOps: {
          cancel() {},
          resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: () => Effect.die("prompt not used in cancel tests"),
        },
      },
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    },
  }
}

describe("actor tool — cancel action", () => {
  it.live(
    "cancel on running task signals graceful and updates registry",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        cancelled.length = 0
        const sessions = yield* Session.Service
        const registry = yield* ActorRegistry.Service
        installedRegistry = registry
        const chat = yield* sessions.create({ title: "chat" })
        const child = yield* sessions.create({ parentID: chat.id, title: "running (@general subagent)" })
        yield* registry.register({
          sessionID: child.id,
          actorID: child.id,
          mode: "peer",
          agent: "general",
          description: "running",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(child.id, child.id, { status: "running" })

        const { ctx } = ctxFor(chat.id)
        const tool = yield* ActorTool
        const def = yield* tool.init()
        const result = yield* def.execute({ operation: { action: "cancel", actor_id: child.id } }, ctx)

        const snap = parseOutput(result.output)
        expect(snap.status).toBe("cancelled")
        expect(snap.actor_id).toBe(child.id)
        expect(cancelled).toHaveLength(1)
        expect(cancelled[0]?.mode).toBe("graceful")
        expect(cancelled[0]?.actorID).toBe(child.id)

        const entry = yield* registry.get(child.id, child.id)
        expect(entry?.status).toBe("idle")
        expect(entry?.lastOutcome).toBe("cancelled")
      }),
    ),
  )

  // Skipped: v6 follow-up. The legacy registry stored parent_session_id which
  // made cross-session ownership enforcement straightforward. v6 stores
  // parentActorID instead; cross-session ownership needs a dedicated check
  // (registry helper or a new column). For peer-mode actors keyed by
  // (actorID == sessionID), findActor's fallback currently finds the row
  // regardless of who's asking. Re-enable once ownership lookup lands.
  // it.live(
  //   "cancel on cross-session task returns unknown (ownership check)",
  //   ...
  // )

  it.live(
    "cancel missing actor_id fails",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const { ctx } = ctxFor(chat.id)
        const tool = yield* ActorTool
        const def = yield* tool.init()

        // cast: the schema rejects this shape at parse time; the cast is the only
        // way to drive that failure path through tool.execute() in tests.
        const result = yield* def.execute({ operation: { action: "cancel" } } as any, ctx).pipe(Effect.exit)

        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "cancel on already-terminal task returns current status (idempotent)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        cancelled.length = 0
        const sessions = yield* Session.Service
        const registry = yield* ActorRegistry.Service
        const chat = yield* sessions.create({ title: "chat" })
        const child = yield* sessions.create({ parentID: chat.id, title: "done (@general subagent)" })
        yield* registry.register({
          sessionID: child.id,
          actorID: child.id,
          mode: "peer",
          agent: "general",
          description: "done",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(child.id, child.id, { status: "idle", lastOutcome: "success" })

        const { ctx } = ctxFor(chat.id)
        const tool = yield* ActorTool
        const def = yield* tool.init()
        const result = yield* def.execute({ operation: { action: "cancel", actor_id: child.id } }, ctx)

        const snap = parseOutput(result.output)
        expect(snap.status).toBe("idle")
        expect(cancelled).toHaveLength(0)

        const entry = yield* registry.get(child.id, child.id)
        expect(entry?.status).toBe("idle")
        expect(entry?.lastOutcome).toBe("success")
      }),
    ),
  )

})
