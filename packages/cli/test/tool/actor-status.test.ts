import { ActorExecution } from "../../src/actor/execution"
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
import { MessageID, type SessionID } from "../../src/session/schema"
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
    ActorWaiter.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(ActorRegistry.defaultLayer),
      Layer.provide(Session.defaultLayer),
    ),
    Team.defaultLayer,
    SessionCheckpoint.defaultLayer,
    TaskRegistry.defaultLayer,
  ),
)

interface StatusResponse {
  status: "pending" | "running" | "idle" | "completed" | "failed" | "cancelled" | "unknown"
  executionState?: string
  actor_id: string
  description?: string
  agent?: string
  background?: boolean
  turnCount?: number
  lastTurnTime?: number
  error?: string
  time?: { created: number; updated: number; completed?: number }
}

function parseOutput(output: string): StatusResponse {
  return JSON.parse(output) as StatusResponse
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

describe("actor tool — status action", () => {
  for (const [outcome, state] of [
    ["success", "completed"],
    ["failure", "failed"],
    ["cancelled", "cancelled"],
  ] as const) {
    it.live(
      `status and wait distinguish ${state} from an interrupted actor`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const registry = yield* ActorRegistry.Service
          const chat = yield* sessions.create({ title: "Outcome query" })
          yield* registry.register({
            sessionID: chat.id,
            actorID: "explore-1",
            mode: "subagent",
            agent: "explore",
            description: "Outcome fixture",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* registry.updateStatus(chat.id, "explore-1", { status: "idle", lastOutcome: outcome })
          const tool = yield* ActorTool
          const def = yield* tool.init()
          for (const action of ["status", "wait"] as const) {
            const result = yield* def.execute({ operation: { action, actor_id: "explore-1" } }, ctxFor(chat.id))
            expect(JSON.parse(result.output)).toMatchObject({ executionState: state, lastOutcome: outcome })
          }
          const executions = yield* ActorExecution.Service
          const execution = yield* executions.reserve(chat.id, "explore-1")
          const running = yield* def.execute(
            { operation: { action: "status", actor_id: "explore-1" } },
            ctxFor(chat.id),
          )
          expect(JSON.parse(running.output)).toMatchObject({ executionState: "running", executionActive: true })
          yield* executions.release(execution)
        }),
      ),
    )
  }

  for (const storedStatus of ["pending", "running"] as const) {
    it.live(
      `restarted ${storedStatus} actor is idle for status and wait without rewriting history`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const registry = yield* ActorRegistry.Service
          const chat = yield* sessions.create({ title: "restart query" })
          yield* registry.register({
            sessionID: chat.id,
            actorID: "explore-1",
            mode: "subagent",
            agent: "explore",
            description: "Interrupted work",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* registry.updateStatus(chat.id, "explore-1", { status: storedStatus })
          const before = yield* registry.get(chat.id, "explore-1")
          const tool = yield* ActorTool
          const def = yield* tool.init()
          for (const action of ["status", "wait"] as const) {
            const result = yield* def.execute(
              { operation: { action, actor_id: "explore-1", ...(action === "wait" ? { timeout_ms: 1 } : {}) } },
              ctxFor(chat.id),
            )
            expect(JSON.parse(result.output)).toMatchObject({
              status: "idle",
              executionActive: false,
              executionState: "stopped",
              actor_id: "explore-1",
            })
            expect(JSON.parse(result.output).lastOutcome).toBeUndefined()
          }
          expect(yield* registry.get(chat.id, "explore-1")).toEqual(before)
        }),
      ),
    )
  }

  it.live(
    "status on unknown actor_id returns { status: 'unknown' }",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const tool = yield* ActorTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            operation: {
              action: "status",
              actor_id: "ses_never_existed",
            },
          },
          ctxFor(chat.id),
        )

        const snap = parseOutput(result.output)
        expect(snap.status).toBe("unknown")
        expect(snap.actor_id).toBe("ses_never_existed")
      }),
    ),
  )

  it.live(
    "status requires actor_id — missing actor_id fails",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "chat" })
        const tool = yield* ActorTool
        const def = yield* tool.init()

        const result = yield* def
          .execute(
            // cast: the schema rejects this shape at parse time; the cast is the
            // only way to drive that failure path through tool.execute() in tests.
            {
              operation: {
                action: "status",
              },
            } as any,
            ctxFor(chat.id),
          )
          .pipe(Effect.exit)

        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "status on running task returns { status: 'running', turnCount, lastTurnTime, description, agent, background, time }",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const registry = yield* ActorRegistry.Service
        const chat = yield* sessions.create({ title: "chat" })
        // Subagent under chat: actorID is `general-1`, sessionID is the parent's.
        const actorID = yield* registry.allocateActorID(chat.id, "general")
        yield* registry.register({
          sessionID: chat.id,
          actorID,
          mode: "subagent",
          agent: "general",
          description: "inspect bug",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(chat.id, actorID, { status: "running" })

        const executions = yield* ActorExecution.Service
        const execution = yield* executions.reserve(chat.id, actorID)
        const tool = yield* ActorTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            operation: {
              action: "status",
              actor_id: actorID,
            },
          },
          ctxFor(chat.id),
        )

        yield* executions.release(execution)
        const snap = parseOutput(result.output)
        expect(snap.status).toBe("running")
        expect(snap.executionState).toBe("running")
        expect(snap.actor_id).toBe(actorID)
        expect(snap.description).toBe("inspect bug")
        expect(snap.agent).toBe("general")
        expect(snap.background).toBe(true)
        expect(snap.turnCount).toBe(0)
        expect(typeof snap.lastTurnTime).toBe("number")
        expect(snap.time).toBeDefined()
        expect(snap.time?.created).toBeGreaterThan(0)
      }),
    ),
  )

  it.live(
    "status on completed task returns { status: 'completed', time.completed set }",
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
          description: "done task",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(chat.id, actorID, { status: "idle", lastOutcome: "success" })

        const tool = yield* ActorTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            operation: {
              action: "status",
              actor_id: actorID,
            },
          },
          ctxFor(chat.id),
        )

        const snap = parseOutput(result.output)
        expect(snap.status).toBe("idle")
        expect(snap.time?.completed).toBeGreaterThan(0)
        expect(snap.executionState).toBe("completed")
      }),
    ),
  )

  it.live(
    "status on failed task returns { status: 'failed', error }",
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
          description: "bad task",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* registry.updateStatus(chat.id, actorID, {
          status: "idle",
          lastOutcome: "failure",
          lastError: "network unreachable",
        })

        const tool = yield* ActorTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            operation: {
              action: "status",
              actor_id: actorID,
            },
          },
          ctxFor(chat.id),
        )

        const snap = parseOutput(result.output)
        expect(snap.status).toBe("idle")
        expect(snap.error).toBe("network unreachable")
        expect(snap.executionState).toBe("failed")
      }),
    ),
  )

  it.live(
    "status on subagent of another session returns 'unknown' (parent ownership boundary)",
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
        yield* registry.updateStatus(chatA.id, actorID, { status: "running" })

        // chatB queries chatA's subagent. Subagent lookup is keyed by
        // (ctx.sessionID, actorID), so the row under chatA is invisible to
        // chatB and the tool reports 'unknown' — preserving the
        // can-only-reap-own-children boundary.
        const tool = yield* ActorTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            operation: {
              action: "status",
              actor_id: actorID,
            },
          },
          ctxFor(chatB.id),
        )

        const snap = parseOutput(result.output)
        expect(snap.status).toBe("unknown")
        expect(snap.actor_id).toBe(actorID)
        expect(snap.description).toBeUndefined()
      }),
    ),
  )
})
