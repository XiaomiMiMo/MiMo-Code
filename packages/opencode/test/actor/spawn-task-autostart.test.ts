import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
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
import { ModelID, ProviderID } from "../../src/provider/schema"
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
import { Created as TaskCreated, Updated as TaskUpdated } from "../../src/task/events"
import { GlobalBus } from "../../src/bus/global"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { Inbox } from "../../src/inbox"

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
    startAuth: () => Effect.die("unexpected MCP auth in spawn tests"),
    authenticate: () => Effect.die("unexpected MCP auth in spawn tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in spawn tests"),
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
  return Layer.mergeAll(
    TestLLMServer.layer,
    Actor.layer.pipe(
      Layer.provideMerge(prompt),
      Layer.provide(Worktree.defaultLayer),
      Layer.provideMerge(taskRegistry),
      // provideMerge (not provide) so the test body can `yield* TaskRegistry.Service`
      // directly to assert on task status; the original spawn.test.ts never needed it.
      Layer.provideMerge(TaskRegistry.defaultLayer),
      Layer.provide(Inbox.defaultLayer),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeLayer())

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

describe("Actor.spawn auto-starts bound task", () => {
  it.live("subagent bound to task_id transitions it to in_progress with owner=actorID", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const tasks = yield* TaskRegistry.Service

        const parent = yield* session.create({
          title: "autostart parent",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        const task = yield* tasks.create({ session_id: parent.id, summary: "do the thing" })
        expect(task.status).toBe("open")

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "work on the task",
          context: "none",
          tools: ["read"],
          background: false,
          model: ref,
          task_id: task.id,
        })
        yield* Deferred.await(result.outcome)

        const after = yield* tasks.get({ session_id: parent.id, id: task.id })
        expect(after?.status).toBe("in_progress")
        expect(after?.owner).toBe(result.actorID)
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("spawn bound to a non-existent task_id still succeeds and mutates nothing", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const tasks = yield* TaskRegistry.Service

        const parent = yield* session.create({
          title: "autostart bad id",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "work with a bogus task id",
          context: "none",
          tools: ["read"],
          background: false,
          model: ref,
          task_id: "T999",
        })
        const outcome = yield* Deferred.await(result.outcome)

        expect(["success", "failure"]).toContain(outcome.status)
        const missing = yield* tasks.get({ session_id: parent.id, id: "T999" })
        expect(missing).toBeUndefined()
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("spawn with no task_id does not touch any task", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const tasks = yield* TaskRegistry.Service

        const parent = yield* session.create({
          title: "autostart unbound",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        const task = yield* tasks.create({ session_id: parent.id, summary: "untouched" })

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "ad-hoc work, no task binding",
          context: "none",
          tools: ["read"],
          background: false,
          model: ref,
        })
        yield* Deferred.await(result.outcome)

        const after = yield* tasks.get({ session_id: parent.id, id: task.id })
        expect(after?.status).toBe("open")
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("publishes task.created and task.updated(kind=started) when auto-starting a bound task", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const tasks = yield* TaskRegistry.Service

        const parent = yield* session.create({
          title: "autostart event",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // TaskRegistry.create + .start publish through their (encapsulated) Bus,
        // which fans out to the module-level GlobalBus singleton — the same channel
        // the server SSE stream / TUI live-update path consumes. The in-process Bus
        // PubSub (Bus.subscribe) is a *separate* instance from the registry's Bus in
        // this layer composition, so we observe via GlobalBus to catch the publish.
        //
        // create() emits task.created; auto-start emits task.updated with kind=started.
        // We can now distinguish them by event.type, so a single ordering flag is
        // unnecessary — each Deferred awaits its own event. Publishes are
        // fire-and-forget (Effect.runFork), so we complete the Deferreds from the
        // sync GlobalBus callback via Effect.runFork(Deferred.succeed(...)).
        const created = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const onGlobal = (e: {
          payload?: { type?: string; properties?: { sessionID?: string; kind?: string } }
        }) => {
          if (e.payload?.properties?.sessionID !== parent.id) return
          if (e.payload.type === TaskCreated.type) {
            Effect.runFork(Deferred.succeed(created, undefined))
            return
          }
          if (e.payload.type === TaskUpdated.type && e.payload.properties?.kind === "started") {
            Effect.runFork(Deferred.succeed(started, undefined))
          }
        }
        GlobalBus.on("event", onGlobal)

        yield* Effect.ensuring(
          Effect.fnUntraced(function* () {
            const task = yield* tasks.create({ session_id: parent.id, summary: "evented" })
            // create()'s task.created has now been published; block until it lands so
            // the next observed event is unambiguously auto-start's.
            yield* Deferred.await(created)

            yield* llm.text("done")

            const result = yield* actor.spawn({
              mode: "subagent",
              sessionID: parent.id,
              agentType: "build",
              task: "trigger the event",
              context: "none",
              tools: ["read"],
              background: false,
              model: ref,
              task_id: task.id,
            })
            yield* Deferred.await(result.outcome)

            // Deterministic: resolves the instant auto-start's task.updated(started)
            // reaches GlobalBus — the publish we're asserting fired, distinct from
            // create's earlier task.created. Bounded by Effect.timeout so a *missing*
            // event fails fast with a TimeoutError instead of hanging until the
            // harness-level timeout.
            yield* Deferred.await(started).pipe(Effect.timeout("10 seconds"))
          })(),
          Effect.sync(() => GlobalBus.off("event", onGlobal)),
        )
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.spawn completion gate (B)", () => {
  it.live("downgrades to partial and lists incomplete tasks when a gate-eligible subagent leaves work open", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const tasks = yield* TaskRegistry.Service

        const parent = yield* session.create({
          title: "gate downgrade",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // First general subagent in this session is allocated actorID "general-1".
        // Pre-create an open task it owns so the gate finds leftover work.
        const task = yield* tasks.create({
          session_id: parent.id,
          summary: "the unfinished thing",
          owner: "general-1",
        })

        // Initial turn + up to MAX_TASK_GATE_SUBAGENT_REACT (2) nudge turns; the model never
        // calls task.done, so the task stays open and the gate caps out.
        yield* llm.text("**Status**: success\n**Summary**: thought I was done")
        yield* llm.text("**Status**: success\n**Summary**: still nothing closed")
        yield* llm.text("**Status**: success\n**Summary**: still nothing closed")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "general",
          task: "do the work",
          context: "none",
          tools: ["read"],
          background: false,
          model: ref,
        })
        expect(result.actorID).toBe("general-1")

        const outcome = yield* Deferred.await(result.outcome).pipe(Effect.timeout("20 seconds"))
        expect(outcome.status).toBe("success")
        if (outcome.status !== "success") throw new Error("unreachable")
        // DB truth wins: model self-reported success, but the open task forces partial.
        expect(outcome.reportedStatus).toBe("partial")
        expect(outcome.incompleteTasks).toContain(task.id)
        expect(outcome.finalText).toContain("**Incomplete tasks**")
        expect(outcome.finalText).toContain(task.id)

        const after = yield* tasks.get({ session_id: parent.id, id: task.id })
        expect(after?.status).toBe("open")
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("does not downgrade a specialized (non-gate-eligible) subagent even with an open owned task", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const tasks = yield* TaskRegistry.Service

        const parent = yield* session.create({
          title: "gate exempt",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // explore has a hardcoded prompt → not gate-eligible. An open task it owns
        // must be ignored by the gate.
        yield* tasks.create({
          session_id: parent.id,
          summary: "explore leftover",
          owner: "explore-1",
        })

        yield* llm.text("**Status**: success\n**Summary**: explored")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "explore",
          task: "look around",
          context: "none",
          tools: ["read"],
          background: false,
          model: ref,
        })

        const outcome = yield* Deferred.await(result.outcome).pipe(Effect.timeout("20 seconds"))
        expect(outcome.status).toBe("success")
        if (outcome.status !== "success") throw new Error("unreachable")
        // Parsed header preserved, no downgrade, no incomplete-task list.
        expect(outcome.reportedStatus).toBe("success")
        expect(outcome.incompleteTasks).toBeUndefined()
      }),
      { git: true, config: providerCfg },
    ),
  )
})
