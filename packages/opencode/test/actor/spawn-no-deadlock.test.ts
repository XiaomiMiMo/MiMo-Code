import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
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
import { Memory } from "../../src/memory"
import { History } from "../../src/history"
import { Team } from "../../src/team"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { SessionCompaction } from "../../src/session/compaction"
import { TaskRegistry } from "../../src/task/registry"
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
      Layer.provideMerge(taskRegistry),
      Layer.provide(TaskRegistry.defaultLayer),
      Layer.provide(Inbox.defaultLayer),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeLayer())

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

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

describe("spawn no-deadlock (F56)", () => {
  it.live(
    "foreground subagent spawn completes without deadlock",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const actor = yield* Actor.Service
          const session = yield* Session.Service

          const parent = yield* session.create({
            title: "deadlock regression",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          // Queue an immediate text response so the subagent loop completes.
          yield* llm.text("done")

          // Spawn a foreground (blocking) subagent with mode=subagent, agentType=general.
          // Under the old deadlock bug (T18/T19), this would hang 4-12h because
          // the subagent was routed back through main's Runner.
          // With F47 fix in place, this completes in <5s with mock LLM.
          const result = yield* actor
            .spawn({
              mode: "subagent",
              sessionID: parent.id,
              agentType: "general",
              task: "Reproduce a minimal coding task to verify no deadlock",
              context: "none",
              tools: ["read"],
              background: false,
              model: ref,
            })
            .pipe(Effect.timeout("10 seconds"))

          // If we reach here, no deadlock occurred.
          // Assert the spawn returned a valid result (not timed out).
          expect(result).toBeDefined()
          expect(result!.actorID).toBeDefined()

          // Wait for outcome and assert it resolved (success or failure — either is fine).
          const outcome = yield* Deferred.await(result!.outcome)
          expect(["success", "failure"]).toContain(outcome.status)
        }),
        { git: true, config: providerCfg },
      ),
    15_000,
  )

  it.live(
    "checkpoint-writer settles (no hang) when session permission is '*':'ask' and a tool triggers an edit ask",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const actor = yield* Actor.Service
          const session = yield* Session.Service

          // Session asks for everything. A non-system agent would block here
          // waiting for a human reply; a system-spawned checkpoint-writer must
          // fail the ask clean (interactive:false → DeniedError) and settle.
          const parent = yield* session.create({
            title: "writer no-deadlock under ask",
            permission: [{ permission: "*", pattern: "*", action: "ask" }],
          })

          // Turn 1: the writer attempts a write to a NON-memory path → triggers
          // ctx.ask({permission:"edit"}). Under "*":"ask" this would hang for a
          // normal agent; the fix denies it clean. Turn 2: a final text so that
          // if the tool-call path somehow returns control, the loop can end.
          yield* llm.tool("write", { file_path: "notes.txt", content: "hello" })
          yield* llm.text("done")

          // context:"none" keeps the test self-contained (no ForkContext capture).
          // The actor is NOT a fork, but its tool calls STILL route through
          // prompt.ts's ask closure, which sets interactive based on
          // SYSTEM_SPAWNED_AGENT_TYPES.has("checkpoint-writer") → false → the
          // hang-killer (Piece 1) is exercised for this agentType.
          const result = yield* actor
            .spawn({
              mode: "subagent",
              sessionID: parent.id,
              agentType: "checkpoint-writer",
              task: "write a checkpoint",
              context: "none",
              tools: ["read", "write", "edit", "apply_patch", "glob", "grep", "task"],
              background: false,
              model: ref,
            })
            .pipe(Effect.timeout("10 seconds"))

          // If we reach here within the timeout, no deadlock occurred.
          expect(result).toBeDefined()
          expect(result!.actorID).toBeDefined()
          const outcome = yield* Deferred.await(result!.outcome)
          expect(["success", "failure"]).toContain(outcome.status)
        }),
        { git: true, config: providerCfg },
      ),
    15_000,
  )
})
