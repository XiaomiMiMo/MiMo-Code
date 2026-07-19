import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq, and, sql } from "drizzle-orm"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider"
import { Env } from "../../src/env"
import { SessionID } from "../../src/session/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { SessionPrune } from "../../src/session/prune"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { Goal } from "../../src/session/goal"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "../../src/tool"
import { Truncate } from "../../src/tool"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { Actor } from "../../src/actor/spawn"
import { Worktree } from "../../src/worktree"
import { Memory } from "../../src/memory"
import { History } from "../../src/history"
import { Team } from "../../src/team"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { SessionCompaction } from "../../src/session/compaction"
import { TaskRegistry } from "../../src/task/registry"
import { defaultLayer as SchedulerDefaultLayer } from "../../src/cron/scheduler"
import { Auth } from "../../src/auth"
import { Database } from "../../src/storage"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { Inbox } from "../../src/inbox"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { DEFAULT_LIVENESS_STALL_MS } from "../../src/actor/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in stall-watchdog tests"),
    authenticate: () => Effect.die("unexpected MCP auth in stall-watchdog tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in stall-watchdog tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

function makeLayer() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const checkpoint = SessionCheckpoint.defaultLayer
  const taskRegistry = ActorRegistry.defaultLayer
  const taskWaiter = ActorWaiter.defaultLayer
  const team = Team.defaultLayer
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(taskRegistry),
    Layer.provide(taskWaiter),
    Layer.provide(team),
    Layer.provide(checkpoint),
    Layer.provide(Memory.defaultLayer),
    Layer.provide(History.defaultLayer),
    Layer.provide(TaskRegistry.defaultLayer),
    Layer.provide(SchedulerDefaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const prune = SessionPrune.layer.pipe(Layer.provide(checkpoint), Layer.provideMerge(deps))
  const prompt = SessionPrompt.layer.pipe(
    Layer.provide(Goal.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(summary),
    Layer.provide(checkpoint),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(team),
    Layer.provide(taskRegistry),
    Layer.provideMerge(run),
    Layer.provideMerge(prune),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(Inbox.defaultLayer),
    Layer.provideMerge(deps),
  )
  const inboxLayer = Inbox.defaultLayer
  return Layer.mergeAll(
    TestLLMServer.layer,
    Actor.layer.pipe(
      Layer.provideMerge(prompt),
      Layer.provide(Worktree.defaultLayer),
      Layer.provideMerge(taskRegistry),
      Layer.provide(TaskRegistry.defaultLayer),
      Layer.provide(SchedulerDefaultLayer),
      Layer.provideMerge(inboxLayer),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeLayer())

// Rows the watchdog would notify: actor_notification to <parent>:main.
const parentInboxRows = (parentID: SessionID) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(InboxTable)
        .where(and(eq(InboxTable.receiver_session_id, parentID), eq(InboxTable.receiver_actor_id, "main")))
        .all(),
    ),
  )

// Backdate a peer's last_turn_time so deriveLiveness reads `stalled` on the next
// scan WITHOUT advancing turn_count — exactly the wedged-child shape the watchdog
// exists to catch. turn_count is forced to >= 1 (the child has run at least one
// turn, then wedged): a not-yet-started child (turnCount 0) is deliberately
// exempt from the stall path, so a stalled row must have run once. Keeps status
// pending/running so it stays in listActive().
const backdateTurn = (sessionID: SessionID, actorID: string, agoMs: number) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .update(ActorRegistryTable)
        .set({ status: "running", last_turn_time: Date.now() - agoMs, turn_count: sql`max(${ActorRegistryTable.turn_count}, 1)` })
        .where(and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)))
        .run(),
    ),
  )

describe("Actor stall watchdog (T40)", () => {
  it.live("stalled background peer notifies parent once, debounces, and re-arms after resume", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service

        const parent = yield* session.create({
          title: "stall-watchdog",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // A real background peer: its own child session, registered exactly like
        // spawnPeer does (session_id === actor_id === child.id, mode peer,
        // parent main). No LLM turn is run — we drive liveness via the DB.
        const child = yield* session.create({ parentID: parent.id, title: "peer child" })
        yield* actorReg.register({
          sessionID: child.id,
          actorID: child.id,
          mode: "peer",
          parentActorID: "main",
          agent: "build",
          description: "stally peer",
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "persistent",
        })

        // (1) Fresh peer (last_turn_time = now) is PROGRESSING → no notification.
        yield* actor.scanStalledOnce!()
        expect((yield* parentInboxRows(parent.id)).length).toBe(0)

        // (2) Push it past the stall window with unchanged turn_count → STALLED.
        //     One scan → exactly ONE notification.
        yield* backdateTurn(child.id, child.id, DEFAULT_LIVENESS_STALL_MS + 60_000)
        yield* actor.scanStalledOnce!()
        const afterFirst = yield* parentInboxRows(parent.id)
        expect(afterFirst.length).toBe(1)
        expect(afterFirst[0].type).toBe("actor_notification")
        const body = afterFirst[0].content as { text?: string }
        expect(body.text).toContain("<actor-notification>")
        expect(body.text).toContain("stally peer")
        expect(body.text).toContain("stalled")

        // (3) Still continuously stalled — repeated scans must NOT re-notify.
        yield* actor.scanStalledOnce!()
        yield* actor.scanStalledOnce!()
        expect((yield* parentInboxRows(parent.id)).length).toBe(1)

        // (4) Child resumes (a turn advances → recent last_turn_time + turnCount++).
        //     Now PROGRESSING: a scan sends nothing new AND re-arms the debounce.
        yield* actorReg.updateTurn(child.id, child.id)
        yield* actor.scanStalledOnce!()
        expect((yield* parentInboxRows(parent.id)).length).toBe(1)

        // (5) It stalls AGAIN after having resumed → a fresh episode → ONE more
        //     notification (total 2), proving the re-arm.
        yield* backdateTurn(child.id, child.id, DEFAULT_LIVENESS_STALL_MS + 60_000)
        yield* actor.scanStalledOnce!()
        expect((yield* parentInboxRows(parent.id)).length).toBe(2)
      }),
      { git: true },
    ),
  )

  it.live("a continuously progressing peer never triggers a stalled notification", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service

        const parent = yield* session.create({
          title: "stall-watchdog-progressing",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const child = yield* session.create({ parentID: parent.id, title: "peer child" })
        yield* actorReg.register({
          sessionID: child.id,
          actorID: child.id,
          mode: "peer",
          parentActorID: "main",
          agent: "build",
          description: "busy peer",
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "persistent",
        })

        // Each tick: advance a turn (fresh last_turn_time) then scan. It always
        // reads progressing, so no notification ever fires.
        for (let i = 0; i < 4; i++) {
          yield* actorReg.updateTurn(child.id, child.id)
          yield* actor.scanStalledOnce!()
        }
        expect((yield* parentInboxRows(parent.id)).length).toBe(0)
      }),
      { git: true },
    ),
  )

  it.live("a stalled SYSTEM-spawned background actor is not notified", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service

        const parent = yield* session.create({
          title: "stall-watchdog-system",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const child = yield* session.create({ parentID: parent.id, title: "writer child" })
        // checkpoint-writer ∈ SYSTEM_SPAWNED_AGENT_TYPES → excluded from notify.
        yield* actorReg.register({
          sessionID: child.id,
          actorID: child.id,
          mode: "peer",
          parentActorID: "main",
          agent: "checkpoint-writer",
          description: "system writer",
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "ephemeral",
        })

        yield* backdateTurn(child.id, child.id, DEFAULT_LIVENESS_STALL_MS + 60_000)
        yield* actor.scanStalledOnce!()
        expect((yield* parentInboxRows(parent.id)).length).toBe(0)
      }),
      { git: true },
    ),
  )
})
