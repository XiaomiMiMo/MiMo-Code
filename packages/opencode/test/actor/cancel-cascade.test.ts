import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider"
import { Env } from "../../src/env"
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
import { TaskGateState } from "../../src/task/gate-state"
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
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { ModelID, ProviderID } from "../../src/provider/schema"
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
    startAuth: () => Effect.die("unexpected MCP auth in cancel-cascade tests"),
    authenticate: () => Effect.die("unexpected MCP auth in cancel-cascade tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in cancel-cascade tests"),
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
    Layer.provide(TaskGateState.defaultLayer),
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
      Layer.provide(TaskRegistry.defaultLayer),
      Layer.provide(SchedulerDefaultLayer),
      Layer.provide(Inbox.defaultLayer),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeLayer())

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

describe("ActorRegistry.listByParent", () => {
  it.live("returns children registered under parent_actor_id", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const reg = yield* ActorRegistry.Service
        const session = yield* Session.Service

        const parent = yield* session.create({ title: "cascade parent" })

        yield* reg.register({
          sessionID: parent.id,
          actorID: "explore-1",
          mode: "subagent",
          agent: "explore",
          description: "parent actor",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
          tools: ["read"],
        })

        yield* reg.register({
          sessionID: parent.id,
          actorID: "general-1",
          mode: "subagent",
          parentActorID: "explore-1",
          agent: "general",
          description: "child 1",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
          tools: ["read"],
        })

        yield* reg.register({
          sessionID: parent.id,
          actorID: "general-2",
          mode: "subagent",
          parentActorID: "explore-1",
          agent: "general",
          description: "child 2",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
          tools: ["read"],
        })

        const children = yield* reg.listByParent(parent.id, "explore-1")
        expect(children.length).toBe(2)
        const ids = children.map((c) => c.actorID).sort()
        expect(ids).toEqual(["general-1", "general-2"])
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.cancel cascade", () => {
  it.live("cancelling parent cascades to children (DFS post-order)", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const actor = yield* Actor.Service
        const reg = yield* ActorRegistry.Service
        const session = yield* Session.Service

        const parent = yield* session.create({ title: "cascade test" })

        // Register a tree: explore-1 -> general-1, general-2
        yield* reg.register({
          sessionID: parent.id,
          actorID: "explore-1",
          mode: "subagent",
          agent: "explore",
          description: "root actor",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
          tools: ["read"],
        })
        yield* reg.updateStatus(parent.id, "explore-1", { status: "running" })

        yield* reg.register({
          sessionID: parent.id,
          actorID: "general-1",
          mode: "subagent",
          parentActorID: "explore-1",
          agent: "general",
          description: "child 1",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
          tools: ["read"],
        })
        yield* reg.updateStatus(parent.id, "general-1", { status: "running" })

        yield* reg.register({
          sessionID: parent.id,
          actorID: "general-2",
          mode: "subagent",
          parentActorID: "explore-1",
          agent: "general",
          description: "child 2",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
          tools: ["read"],
        })
        yield* reg.updateStatus(parent.id, "general-2", { status: "running" })

        // Cancel the root — should cascade to children
        yield* actor.cancel(parent.id, "explore-1", "graceful")

        // Assert all 3 are idle with cancelled outcome (new schema)
        const root = yield* reg.get(parent.id, "explore-1")
        expect(root?.status).toBe("idle")
        expect(root?.lastOutcome).toBe("cancelled")

        const child1 = yield* reg.get(parent.id, "general-1")
        expect(child1?.status).toBe("idle")
        expect(child1?.lastOutcome).toBe("cancelled")

        const child2 = yield* reg.get(parent.id, "general-2")
        expect(child2?.status).toBe("idle")
        expect(child2?.lastOutcome).toBe("cancelled")
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("cancelling a leaf actor does not affect siblings", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const actor = yield* Actor.Service
        const reg = yield* ActorRegistry.Service
        const session = yield* Session.Service

        const parent = yield* session.create({ title: "leaf cancel" })

        yield* reg.register({
          sessionID: parent.id,
          actorID: "explore-1",
          mode: "subagent",
          agent: "explore",
          description: "root",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
          tools: ["read"],
        })
        yield* reg.updateStatus(parent.id, "explore-1", { status: "running" })

        yield* reg.register({
          sessionID: parent.id,
          actorID: "general-1",
          mode: "subagent",
          parentActorID: "explore-1",
          agent: "general",
          description: "child 1",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
          tools: ["read"],
        })
        yield* reg.updateStatus(parent.id, "general-1", { status: "running" })

        yield* reg.register({
          sessionID: parent.id,
          actorID: "general-2",
          mode: "subagent",
          parentActorID: "explore-1",
          agent: "general",
          description: "child 2",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
          tools: ["read"],
        })
        yield* reg.updateStatus(parent.id, "general-2", { status: "running" })

        // Cancel only child 1
        yield* actor.cancel(parent.id, "general-1", "graceful")

        const child1 = yield* reg.get(parent.id, "general-1")
        expect(child1?.status).toBe("idle")
        expect(child1?.lastOutcome).toBe("cancelled")

        // Sibling and parent should remain running
        const root = yield* reg.get(parent.id, "explore-1")
        expect(root?.status).toBe("running")

        const child2 = yield* reg.get(parent.id, "general-2")
        expect(child2?.status).toBe("running")
      }),
      { git: true, config: providerCfg },
    ),
  )
})
