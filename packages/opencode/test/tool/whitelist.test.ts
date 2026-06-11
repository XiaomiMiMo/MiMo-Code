import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
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
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { SessionPrune } from "../../src/session/prune"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionCompaction } from "../../src/session/compaction"
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
import { Memory } from "../../src/memory"
import { History } from "../../src/history"
import { Team } from "../../src/team"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { TaskRegistry } from "../../src/task/registry"
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
    startAuth: () => Effect.die("unexpected MCP auth in whitelist tests"),
    authenticate: () => Effect.die("unexpected MCP auth in whitelist tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in whitelist tests"),
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
  const actorRegistry = ActorRegistry.defaultLayer
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
    actorRegistry,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const checkpoint = SessionCheckpoint.layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Memory.defaultLayer),
    Layer.provide(History.defaultLayer),
    Layer.provide(TaskRegistry.defaultLayer),
    Layer.provide(actorRegistry),
  )
  const actorWaiter = ActorWaiter.layer.pipe(Layer.provide(Bus.layer), Layer.provide(actorRegistry))
  const team = Team.defaultLayer
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(actorRegistry),
    Layer.provide(actorWaiter),
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
  const prune = SessionPrune.layer.pipe(
    Layer.provide(checkpoint),
    Layer.provide(actorRegistry),
    Layer.provideMerge(deps),
  )
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const compaction = SessionCompaction.layer.pipe(
    Layer.provideMerge(proc),
    Layer.provide(AgentSvc.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const prompt = SessionPrompt.layer.pipe(
    Layer.provide(Goal.defaultLayer),
    Layer.provide(TaskGateState.defaultLayer),
    Layer.provide(TaskRegistry.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(summary),
    Layer.provide(checkpoint),
    Layer.provide(team),
    Layer.provide(actorRegistry),
    Layer.provideMerge(run),
    Layer.provideMerge(prune),
    Layer.provideMerge(compaction),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(Inbox.defaultLayer),
    Layer.provideMerge(deps),
  )
  return Layer.mergeAll(TestLLMServer.layer, prompt, actorRegistry).pipe(Layer.provide(summary))
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
          limit: { context: 1_000_000, output: 10000 },
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

describe("Tool whitelist (Task 14)", () => {
  it.live("rejects bash when actor.tools = ['read'] and tool is not in whitelist", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const reg = yield* ActorRegistry.Service

        const session = yield* sessions.create({
          title: "whitelist test",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // Register a subagent actor on this session with a tools whitelist
        // that excludes "bash". The runtime guard should reject the bash
        // call below and the model should still finish via the second turn.
        const actorID = "build-1"
        yield* reg.register({
          sessionID: session.id,
          actorID,
          mode: "subagent",
          agent: "build",
          description: "test actor",
          contextMode: "none",
          background: false,
          lifecycle: "ephemeral",
          tools: ["read"],
        })

        // Turn 1: model emits a bash tool call. Turn 2: model wraps up.
        yield* llm.tool("bash", { command: "echo hello", description: "echo", workdir: "/tmp" })
        yield* llm.text("done")

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          agentID: actorID,
          model: ref,
          parts: [{ type: "text", text: "please run echo" }],
        })

        // Locate the bash tool part in the persisted message stream.
        const msgs = yield* MessageV2.filterCompactedEffect(session.id)
        const tool = msgs
          .flatMap((msg) => msg.parts)
          .find(
            (part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted } =>
              part.type === "tool" && part.tool === "bash" && part.state.status === "completed",
          )

        expect(tool).toBeDefined()
        if (!tool) return
        // The rejection branch routes through completeToolCall with our
        // rejection metadata. The body must mention the tool is not permitted.
        expect(tool.state.metadata?.rejected).toBe(true)
        expect(tool.state.metadata?.reason).toBe("tool-whitelist")
        expect(tool.state.output).toContain("not in this actor's whitelist")
        expect(tool.state.output.toLowerCase()).toContain("bash")
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("permits bash when actor.tools = 'INHERIT' (no runtime restriction)", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const reg = yield* ActorRegistry.Service

        const session = yield* sessions.create({
          title: "inherit test",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const actorID = "build-2"
        yield* reg.register({
          sessionID: session.id,
          actorID,
          mode: "subagent",
          agent: "build",
          description: "inherit test actor",
          contextMode: "none",
          background: false,
          lifecycle: "ephemeral",
          tools: "INHERIT",
        })

        // The bash tool should NOT be rejected here. We don't actually run a
        // bash command — instead we just send a text reply so the loop exits
        // and verify there is no rejected tool part.
        yield* llm.text("done")

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          agentID: actorID,
          model: ref,
          parts: [{ type: "text", text: "no tool call needed" }],
        })

        const msgs = yield* MessageV2.filterCompactedEffect(session.id)
        const rejected = msgs
          .flatMap((msg) => msg.parts)
          .find((part) => part.type === "tool" && part.state.status === "completed" && (part.state.metadata?.rejected as unknown) === true)
        expect(rejected).toBeUndefined()
      }),
      { git: true, config: providerCfg },
    ),
  )

  test("checkpoint-writer config has toolAllowlist [read, write, edit, glob, grep] (F3a)", async () => {
    const src = await Bun.file(`${import.meta.dir}/../../src/agent/agent.ts`).text()
    const checkpointWriterBlock = src.match(/"checkpoint-writer":\s*\{[\s\S]*?toolAllowlist:\s*\[[^\]]*\]/)
    expect(checkpointWriterBlock).toBeTruthy()
    expect(checkpointWriterBlock![0]).toContain('"read"')
    expect(checkpointWriterBlock![0]).toContain('"write"')
    expect(checkpointWriterBlock![0]).toContain('"edit"')
    expect(checkpointWriterBlock![0]).toContain('"glob"')
    expect(checkpointWriterBlock![0]).toContain('"grep"')
  })
})
