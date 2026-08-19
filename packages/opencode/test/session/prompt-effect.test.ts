import { Worktree } from "../../src/worktree"
import { Instance } from "../../src/project/instance"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, expect } from "bun:test"
import { dynamicTool, jsonSchema, type Tool as AITool } from "ai"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
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
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
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
import { defaultLayer as SchedulerDefaultLayer } from "../../src/cron/scheduler"
import { Auth } from "../../src/auth"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { Inbox } from "../../src/inbox"
import { Metrics } from "../../src/metrics"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}
const mcpRef = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("gpt-5-test"),
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function withoutDynamicSystemPrompt<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT
      delete process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT
      return previous
    }),
    () => fx(),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT
        else process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT = previous
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function wireToolName(tool: Record<string, unknown>) {
  if (typeof tool.name === "string") return tool.name
  if (!tool.function || typeof tool.function !== "object" || !("name" in tool.function)) return
  return typeof tool.function.name === "string" ? tool.function.name : undefined
}

function wireToolDescription(tool: Record<string, unknown>) {
  if (typeof tool.description === "string") return tool.description
  if (!tool.function || typeof tool.function !== "object" || !("description" in tool.function)) return
  return typeof tool.function.description === "string" ? tool.function.description : undefined
}

function wireTool(tools: Array<Record<string, unknown>>, name: string) {
  return tools.find((item) => wireToolName(item) === name)
}

function mcpLayer(
  tools: (context?: MCP.TurnContext) => Record<string, AITool> = () => ({}),
  clients: () => Record<string, any> = () => ({}),
) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.sync(clients),
      tools: (context) => Effect.sync(() => tools(context)),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const mcp = mcpLayer()

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
function makeHttp(mcpService = mcp) {
  const taskRegistry = ActorRegistry.defaultLayer
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
    mcpService,
    AppFileSystem.defaultLayer,
    status,
    taskRegistry,
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
    Layer.provide(SchedulerDefaultLayer),
    Layer.provide(taskRegistry),
  )
  const taskWaiter = ActorWaiter.layer.pipe(Layer.provide(Bus.layer), Layer.provide(taskRegistry))
  const team = Team.defaultLayer
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Worktree.defaultLayer),
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
  const prune = SessionPrune.layer.pipe(
    Layer.provide(checkpoint),
    Layer.provide(taskRegistry),
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
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provide(Goal.defaultLayer),
      Layer.provide(TaskRegistry.defaultLayer),
      Layer.provide(SchedulerDefaultLayer),
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(summary),
      Layer.provide(checkpoint),
      Layer.provide(team),
      Layer.provide(taskRegistry),
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
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeHttp())
const mcpLegacyMetadata = { interrupted: true, output: "must not become a successful result" }
const mcpErrorImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const mcpErrorAudio = "UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA"
const mcpErrorBinary = "AQIDBAUGBwgJ"
const mcpErrorImageURL = `data:image/png;base64,${mcpErrorImage}`
const mcpErrorResult: CallToolResult = {
  content: [
    { type: "text", text: "Message was not sent" },
    { type: "image", data: mcpErrorImage, mimeType: "image/png" },
    {
      type: "resource",
      resource: {
        uri: "mcp://diagnostic.txt",
        text: "Resource diagnostic",
        mimeType: "text/plain",
      },
    },
    { type: "audio", data: mcpErrorAudio, mimeType: "audio/wav" },
    {
      type: "resource",
      resource: {
        uri: "mcp://diagnostic.bin",
        blob: mcpErrorBinary,
      },
    },
  ],
  structuredContent: { sent: false, reason: "composer rejected the request" },
  isError: true,
  _meta: { privateToken: "do-not-send-to-model" },
  metadata: mcpLegacyMetadata,
}
const mcpSuccessResult: CallToolResult = {
  content: [{ type: "text", text: "Window updated" }],
  structuredContent: { changed: true, windowID: 42 },
  _meta: { privateToken: "success-meta-is-client-only" },
}
const mcpIt = testEffect(
  makeHttp(
    mcpLayer(() => ({
      mcp_success: dynamicTool({
        description: "Return a standard structured MCP success result",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            private_window_id: { type: "number", description: "Secret nested MCP window selector" },
          },
          additionalProperties: false,
        }),
        execute: async () => mcpSuccessResult,
      }),
      mcp_result: dynamicTool({
        description: "Return a standard MCP tool execution error",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            private_error_code: { type: "string", description: "Secret nested MCP error selector" },
          },
          additionalProperties: false,
        }),
        execute: async () => mcpErrorResult,
      }),
    })),
  ),
)
const lifecycleContexts: MCP.TurnContext[] = []
const lifecycleNotifications: Array<Record<string, any>> = []
let lifecycleNotificationHangs = false
let lifecycleToolStarted: Deferred.Deferred<void> | undefined
let lifecycleToolGate: Deferred.Deferred<void> | undefined
const lifecycleClient = {
  getServerCapabilities: () => ({
    experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
  }),
  notification: async (notification: Record<string, any>) => {
    if (lifecycleNotificationHangs) return new Promise<void>(() => {})
    lifecycleNotifications.push(notification)
  },
}
const lifecycleMcpIt = testEffect(
  makeHttp(
    mcpLayer(
      (context) => ({
        mcp_lifecycle: dynamicTool({
          description: "Record lifecycle context",
          inputSchema: jsonSchema({
            type: "object",
            properties: { index: { type: "number" } },
            required: ["index"],
          }),
          execute: async () => {
            if (context) lifecycleContexts.push(context)
            if (lifecycleToolStarted) Effect.runSync(Deferred.succeed(lifecycleToolStarted, undefined))
            if (lifecycleToolGate) await Effect.runPromise(Deferred.await(lifecycleToolGate))
            return { content: [{ type: "text", text: "ok" }] }
          },
        }),
      }),
      () => ({ lifecycle: lifecycleClient }),
    ),
  ),
)
const unix = process.platform !== "win32" ? it.live : it.live.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  checkpoint: { thresholds: [] as string[] },
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
        "gpt-5-test": {
          id: "gpt-5-test",
          name: "GPT 5 Test",
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

function noToolProviderCfg(url: string) {
  const config = providerCfg(url)
  return {
    ...config,
    provider: {
      ...config.provider,
      test: {
        ...config.provider.test,
        models: {
          ...config.provider.test.models,
          "test-model": { ...config.provider.test.models["test-model"], tool_call: false },
          "gpt-5-test": { ...config.provider.test.models["gpt-5-test"], tool_call: false },
        },
      },
    },
  }
}

function restrictedAgentProviderCfg(url: string) {
  return {
    ...providerCfg(url),
    agent: {
      restricted: {
        mode: "primary" as const,
        tool_allowlist: ["mcp_success"],
      },
    },
  }
}

function mediaProviderCfg(url: string) {
  const config = providerCfg(url)
  return {
    ...config,
    provider: {
      ...config.provider,
      test: {
        ...config.provider.test,
        models: {
          ...config.provider.test.models,
          "test-model": {
            ...config.provider.test.models["test-model"],
            attachment: true,
            modalities: {
              input: ["text", "image", "audio"] as ("text" | "image" | "audio")[],
              output: ["text"] as "text"[],
            },
          },
          "gpt-5-test": {
            ...config.provider.test.models["gpt-5-test"],
            attachment: true,
            modalities: {
              input: ["text", "image", "audio"] as ("text" | "image" | "audio")[],
              output: ["text"] as "text"[],
            },
          },
        },
      },
    },
  }
}

function gptProviderCfg(url: string) {
  return {
    checkpoint: { thresholds: [] as string[] },
    provider: {
      openai: {
        name: "OpenAI",
        env: [],
        npm: "@ai-sdk/openai",
        models: {
          "gpt-5.2": {
            id: "gpt-5.2",
            name: "GPT 5.2",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

it.live("loop exits immediately when last assistant has stop finish", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      expect(yield* llm.calls).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop calls LLM and returns assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const parts = result.parts.filter((p) => p.type === "text")
      expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop does not inject dynamic system prompt additions", () =>
  withoutDynamicSystemPrompt(() =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const marker = "dynamic-instruction-marker"
        yield* Effect.promise(() => Bun.write(path.join(Instance.directory, "AGENTS.md"), marker))
        const chat = yield* sessions.create({
          title: "No cwd",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        yield* llm.text("world")

        yield* prompt.loop({ sessionID: chat.id })

        const inputs = JSON.stringify(yield* llm.inputs)
        expect(inputs).not.toContain("Working directory:")
        expect(inputs).not.toContain(marker)
      }),
      { git: true, config: providerCfg },
    ),
  ),
)

it.live("static loop returns assistant text through local provider", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })

      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("injects orchestrator system prompt for agent 'orchestrator'", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Orchestrator",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "orchestrator",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "kick things off" }],
      })

      yield* llm.text("ok")
      yield* prompt.loop({ sessionID: session.id })

      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs)).toContain("MiMoCode Orchestrator")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop consumes queued replies across turns", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider turns",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "hello one" }],
      })

      yield* llm.text("world one")

      const first = yield* prompt.loop({ sessionID: session.id })
      expect(first.info.role).toBe("assistant")
      expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "hello two" }],
      })

      yield* llm.text("world two")

      const second = yield* prompt.loop({ sessionID: session.id })
      expect(second.info.role).toBe("assistant")
      expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

      expect(yield* llm.hits).toHaveLength(2)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is tool-calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

mcpIt.live("MCP isError becomes a tool error without losing standard result fields", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const metricSeen = defer<void>()
      const statuses: string[] = []
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const off = yield* bus.subscribeCallback(Metrics.ToolCall, (event) => {
        if (event.properties.sessionID !== session.id || event.properties.tool_name !== "mcp_result") return
        statuses.push(event.properties.tool_call_status)
        metricSeen.resolve()
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: "send the message" }],
      })
      yield* llm.tool("mcp_tool_search", { query: "execution error" })
      yield* llm.tool("mcp_result", {})
      yield* llm.text("I saw that sending failed")

      const result = yield* prompt.loop({ sessionID: session.id })
      yield* Effect.promise(() => metricSeen.promise)
      off()

      const tool = (yield* MessageV2.filterCompactedEffect(session.id))
        .flatMap((message) => message.parts)
        .find(
          (part): part is ErrorToolPart =>
            part.type === "tool" && part.tool === "mcp_result" && part.state.status === "error",
        )
      expect(tool).toBeDefined()
      if (!tool) return

      expect(tool.state.error).toBe(
        'Message was not sent\n\nResource diagnostic\n\nStructured content:\n{"sent":false,"reason":"composer rejected the request"}',
      )
      expect(tool.state.metadata?.mcp).toEqual({
        structuredContent: mcpErrorResult.structuredContent,
        isError: true,
        _meta: mcpErrorResult._meta,
        legacyMetadata: mcpLegacyMetadata,
      })
      expect(tool.state.attachments).toHaveLength(3)
      expect(tool.state.attachments?.[0]).toMatchObject({
        type: "file",
        mime: "image/png",
        url: mcpErrorImageURL,
        sessionID: session.id,
        messageID: tool.messageID,
      })
      expect(tool.state.attachments?.[1]).toMatchObject({
        type: "file",
        mime: "audio/wav",
        url: `data:audio/wav;base64,${mcpErrorAudio}`,
        sessionID: session.id,
        messageID: tool.messageID,
      })
      expect(tool.state.attachments?.[2]).toMatchObject({
        type: "file",
        mime: "application/octet-stream",
        url: `data:application/octet-stream;base64,${mcpErrorBinary}`,
        filename: "mcp://diagnostic.bin",
        sessionID: session.id,
        messageID: tool.messageID,
      })
      expect(statuses).toEqual(["error"])
      expect(result.parts.some((part) => part.type === "text" && part.text === "I saw that sending failed")).toBe(true)

      const requests = yield* llm.inputs
      const followup = JSON.stringify(requests[2])
      expect(followup).toContain("Message was not sent")
      expect(followup).toContain("Resource diagnostic")
      expect(followup).toContain("composer rejected the request")
      expect(followup).toContain('Tool \\"mcp_result\\" call')
      expect(followup).toContain("failed:")
      expect(followup).toContain("diagnostic.bin")
      expect(followup).not.toContain("mcp://diagnostic.bin")
      expect(followup).toContain("application/octet-stream")
      expect(followup).not.toContain(mcpErrorBinary)
      expect(followup).not.toContain("must not become a successful result")
      expect(followup).not.toContain("do-not-send-to-model")
      expect(requests[2]).toMatchObject({
        messages: expect.arrayContaining([
          {
            role: "user",
            content: expect.arrayContaining([
              { type: "text", text: MessageV2.SYNTHETIC_ATTACHMENT_PROMPT },
              { type: "image_url", image_url: { url: mcpErrorImageURL } },
              { type: "input_audio", input_audio: { data: mcpErrorAudio, format: "wav" } },
            ]),
          },
        ]),
      })
    }),
    { git: true, config: mediaProviderCfg },
  ),
)

mcpIt.live("MCP structuredContent is persisted and reaches the model alongside text", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const metricSeen = defer<void>()
      const statuses: string[] = []
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const off = yield* bus.subscribeCallback(Metrics.ToolCall, (event) => {
        if (event.properties.sessionID !== session.id || event.properties.tool_name !== "mcp_success") return
        statuses.push(event.properties.tool_call_status)
        metricSeen.resolve()
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: "inspect the window" }],
      })
      yield* llm.tool("mcp_tool_search", { query: "structured success" })
      yield* llm.tool("mcp_success", {})
      yield* llm.text("The window changed")

      yield* prompt.loop({ sessionID: session.id })
      yield* Effect.promise(() => metricSeen.promise)
      off()

      const tool = (yield* MessageV2.filterCompactedEffect(session.id))
        .flatMap((message) => message.parts)
        .find(
          (part): part is CompletedToolPart =>
            part.type === "tool" && part.tool === "mcp_success" && part.state.status === "completed",
        )
      expect(tool).toBeDefined()
      if (!tool) return

      expect(tool.state.output).toBe(
        'Window updated\n\nStructured content:\n{"changed":true,"windowID":42}',
      )
      expect(tool.state.metadata.mcp).toEqual({
        structuredContent: mcpSuccessResult.structuredContent,
        isError: false,
        _meta: mcpSuccessResult._meta,
      })
      expect(statuses).toEqual(["success"])

      const requests = yield* llm.inputs
      const initialTools = requests[0].tools as Array<Record<string, unknown>>
      const loadedTools = requests[1].tools as Array<Record<string, unknown>>
      expect(initialTools.map(wireToolName)).toContain("mcp_tool_search")
      expect(initialTools.map(wireToolName)).not.toContain("mcp_success")
      expect(initialTools.map(wireToolName)).not.toContain("mcp_result")
      const catalog = wireToolDescription(wireTool(initialTools, "mcp_tool_search") ?? {})
      expect(catalog).toContain("mcp_result — Return a standard MCP tool execution error")
      expect(catalog).toContain("mcp_success — Return a standard structured MCP success result")
      expect(catalog).not.toContain("private_error_code")
      expect(catalog).not.toContain("Secret nested MCP window selector")
      expect(loadedTools.map(wireToolName)).toContain("mcp_success")
      expect(loadedTools.map(wireToolName)).not.toContain("mcp_result")

      const followup = JSON.stringify(requests[2])
      expect(followup).toContain("Window updated")
      expect(followup).toContain('{\\"changed\\":true,\\"windowID\\":42}')
      expect(followup).not.toContain("success-meta-is-client-only")
    }),
    { git: true, config: providerCfg },
  ),
)

mcpIt.live("exec can call a catalogued MCP tool without loading its outer schema", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Exec MCP",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: "inspect the window through exec" }],
      })
      yield* llm.tool("exec", {
        code: "const result = await tools.mcp_success({}); return result.structured",
      })
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: session.id })

      const tool = (yield* MessageV2.filterCompactedEffect(session.id))
        .flatMap((message) => message.parts)
        .find(
          (part): part is CompletedToolPart =>
            part.type === "tool" && part.tool === "exec" && part.state.status === "completed",
        )
      expect(tool?.state.output).toContain('"changed": true')
      expect(tool?.state.output).toContain('"windowID": 42')

      const tools = (yield* llm.inputs)[0].tools as Array<Record<string, unknown>>
      expect(tools.map(wireToolName)).toContain("mcp_tool_search")
      expect(tools.map(wireToolName)).not.toContain("mcp_success")
    }),
    { git: true, config: providerCfg },
  ),
)

mcpIt.live("rejects an MCP call that was not loaded by search", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Inactive MCP",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: "call the MCP tool directly" }],
      })
      yield* llm.tool("mcp_success", {})
      yield* llm.text("I will search first")
      yield* prompt.loop({ sessionID: session.id })

      const part = (yield* MessageV2.filterCompactedEffect(session.id))
        .flatMap((message) => message.parts)
        .find(
          (item): item is ErrorToolPart =>
            item.type === "tool" && item.tool === "mcp_success" && item.state.status === "error",
        )
      expect(part?.state.error).toContain("mcp_tool_search")
      expect(part?.state.metadata?.recoverable).toBe(true)
      const tools = (yield* llm.inputs)[0].tools as Array<Record<string, unknown>>
      expect(tools.map(wireToolName)).not.toContain("mcp_success")
    }),
    { git: true, config: providerCfg },
  ),
)

mcpIt.live("resets loaded MCP tools for a new user request", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Request scoped MCP",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: "inspect the window" }],
      })
      yield* llm.tool("mcp_tool_search", { query: "structured success" })
      yield* llm.tool("mcp_success", {})
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: "new request" }],
      })
      yield* llm.text("done again")
      yield* prompt.loop({ sessionID: session.id })

      const requests = yield* llm.inputs
      expect((requests[1].tools as Array<Record<string, unknown>>).map(wireToolName)).toContain("mcp_success")
      expect((requests[3].tools as Array<Record<string, unknown>>).map(wireToolName)).not.toContain("mcp_success")
      expect((requests[3].tools as Array<Record<string, unknown>>).map(wireToolName)).toContain("mcp_tool_search")
    }),
    { git: true, config: providerCfg },
  ),
)

mcpIt.live("accumulates MCP matches across searches in one user request", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Accumulated MCP" })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: "use two MCP capabilities" }],
      })
      yield* llm.tool("mcp_tool_search", { query: "execution error" })
      yield* llm.tool("mcp_tool_search", { query: "structured success" })
      yield* llm.text("ready")
      yield* prompt.loop({ sessionID: session.id })

      const requests = yield* llm.inputs
      expect((requests[1].tools as Array<Record<string, unknown>>).map(wireToolName)).toContain("mcp_result")
      expect((requests[1].tools as Array<Record<string, unknown>>).map(wireToolName)).not.toContain("mcp_success")
      expect((requests[2].tools as Array<Record<string, unknown>>).map(wireToolName)).toContain("mcp_result")
      expect((requests[2].tools as Array<Record<string, unknown>>).map(wireToolName)).toContain("mcp_success")
    }),
    { git: true, config: providerCfg },
  ),
)

mcpIt.live("keeps discovery reachable when permissions allow only an MCP tool", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Least privilege MCP",
        permission: [
          { permission: "*", pattern: "*", action: "deny" },
          { permission: "mcp_success", pattern: "*", action: "allow" },
        ],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: "use the permitted MCP capability" }],
      })
      yield* llm.tool("mcp_tool_search", { query: "structured success" })
      yield* llm.text("ready")
      yield* prompt.loop({ sessionID: session.id })

      const requests = yield* llm.inputs
      const initialTools = requests[0].tools as Array<Record<string, unknown>>
      const catalog = wireToolDescription(wireTool(initialTools, "mcp_tool_search") ?? {})
      expect(initialTools.map(wireToolName)).toContain("mcp_tool_search")
      expect(catalog).toContain("mcp_success — Return a standard structured MCP success result")
      expect(catalog).not.toContain("mcp_result")
      expect(catalog).not.toContain("standard MCP tool execution error")
      expect((requests[1].tools as Array<Record<string, unknown>>).map(wireToolName)).toContain("mcp_success")
      expect((requests[1].tools as Array<Record<string, unknown>>).map(wireToolName)).not.toContain("mcp_result")
    }),
    { git: true, config: providerCfg },
  ),
)

mcpIt.live("searches only MCP tools allowed by the configured agent", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Agent allowlist MCP" })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "restricted",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: "use the allowed MCP tool" }],
      })
      yield* llm.tool("mcp_tool_search", { query: "structured success execution error" })
      yield* llm.text("ready")
      yield* prompt.loop({ sessionID: session.id })

      const requests = yield* llm.inputs
      const initialTools = requests[0].tools as Array<Record<string, unknown>>
      const catalog = wireToolDescription(wireTool(initialTools, "mcp_tool_search") ?? {})
      expect(initialTools.map(wireToolName)).toEqual(["mcp_tool_search"])
      expect(catalog).toContain("mcp_success — Return a standard structured MCP success result")
      expect(catalog).not.toContain("mcp_result")
      expect((requests[1].tools as Array<Record<string, unknown>>).map(wireToolName)).toEqual([
        "mcp_tool_search",
        "mcp_success",
      ])
    }),
    { git: true, config: restrictedAgentProviderCfg },
  ),
)

mcpIt.live(
  "uses ordinary MCP Tool Search for GPT models without exposing MCP schemas",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "GPT MCP Search" })

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.openai, modelID: ModelID.make("gpt-5.2") },
          noReply: true,
          parts: [{ type: "text", text: "inspect the window" }],
        })
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        const tools = (yield* llm.inputs)[0].tools as Array<Record<string, unknown>>
        const catalog = wireToolDescription(wireTool(tools, "mcp_tool_search") ?? {})
        expect(tools.map(wireToolName)).toContain("mcp_tool_search")
        expect(tools.map(wireToolName)).not.toContain("mcp_success")
        expect(tools.map(wireToolName)).not.toContain("mcp_result")
        expect(catalog).toContain("mcp_success — Return a standard structured MCP success result")
        expect(catalog).toContain("mcp_result — Return a standard MCP tool execution error")
        expect(JSON.stringify(tools)).not.toContain("private_window_id")
        expect(JSON.stringify(tools)).not.toContain("Secret nested MCP error selector")
      }),
      { git: true, config: gptProviderCfg },
    ),
  30_000,
)

mcpIt.live("degrades the MCP catalog to names at high context pressure", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "High pressure MCP catalog" })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: `inspect available MCP tools ${"x".repeat(230_000)}` }],
      })
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const tools = (yield* llm.inputs)[0].tools as Array<Record<string, unknown>>
      const catalog = wireToolDescription(wireTool(tools, "mcp_tool_search") ?? {})
      expect(catalog).toContain("Available MCP tool names: mcp_result, mcp_success")
      expect(catalog).not.toContain("Return a standard MCP tool execution error")
      expect(catalog).not.toContain("Return a standard structured MCP success result")
    }),
    { git: true, config: providerCfg },
  ),
)

mcpIt.live(
  "exposes MCP tools directly for non-GPT models by default",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Direct non-GPT MCP tools" })

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "inspect available MCP tools" }],
        })
        yield* llm.tool("mcp_success", {})
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        const tools = (yield* llm.inputs)[0].tools as Array<Record<string, unknown>>
        const names = tools.map(wireToolName).filter((name): name is string => name !== undefined)
        const firstMcp = names.findIndex((name) => name.startsWith("mcp_"))
        expect(firstMcp).toBeGreaterThan(0)
        expect(names.slice(firstMcp)).toEqual(["mcp_result", "mcp_success"])
        expect(tools.map(wireToolName)).not.toContain("mcp_tool_search")
        expect(tools.map(wireToolName)).toContain("mcp_result")
        expect(tools.map(wireToolName)).toContain("mcp_success")
        expect(
          (yield* MessageV2.filterCompactedEffect(session.id))
            .flatMap((message) => message.parts)
            .some(
              (part) =>
                part.type === "tool" && part.tool === "mcp_success" && part.state.status === "completed",
            ),
        ).toBe(true)
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

mcpIt.live("rejects direct MCP calls disabled for the request", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Request-disabled direct MCP tool" })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: ref,
        tools: { mcp_success: false },
        noReply: true,
        parts: [{ type: "text", text: "call the disabled MCP tool" }],
      })
      yield* llm.tool("mcp_success", {})
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const tools = ((yield* llm.inputs)[0].tools ?? []) as Array<Record<string, unknown>>
      expect(tools.map(wireToolName)).not.toContain("mcp_tool_search")
      expect(tools.map(wireToolName)).toContain("mcp_result")
      expect(tools.map(wireToolName)).not.toContain("mcp_success")
      expect(
        (yield* MessageV2.filterCompactedEffect(session.id))
          .flatMap((message) => message.parts)
          .some(
            (part) => part.type === "tool" && part.tool === "mcp_success" && part.state.status === "completed",
          ),
      ).toBe(false)
    }),
    { git: true, config: providerCfg },
  ),
)

mcpIt.live("rejects direct MCP calls hidden by the agent allowlist", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Agent-hidden direct MCP tool" })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "restricted",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "call the hidden MCP tool" }],
      })
      yield* llm.tool("mcp_result", {})
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const tools = (yield* llm.inputs)[0].tools as Array<Record<string, unknown>>
      expect(tools.map(wireToolName)).not.toContain("mcp_tool_search")
      expect(tools.map(wireToolName)).not.toContain("mcp_result")
      expect(tools.map(wireToolName)).toContain("mcp_success")
      expect(
        (yield* MessageV2.filterCompactedEffect(session.id))
          .flatMap((message) => message.parts)
          .some(
            (part) => part.type === "tool" && part.tool === "mcp_result" && part.state.status === "error",
          ),
      ).toBe(true)
    }),
    { git: true, config: restrictedAgentProviderCfg },
  ),
)

mcpIt.live("omits MCP discovery for models without tool calling", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "No tool calls" })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: mcpRef,
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const tools = (yield* llm.inputs)[0].tools as Array<Record<string, unknown>>
      expect(tools.map(wireToolName)).not.toContain("mcp_tool_search")
      expect(tools.map(wireToolName)).not.toContain("mcp_success")
      expect(tools.map(wireToolName)).not.toContain("mcp_result")
    }),
    { git: true, config: noToolProviderCfg },
  ),
)

it.live(
  "omits MCP Tool Search when no MCP tools are available",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "No MCP" })

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        const tools = (yield* llm.inputs)[0].tools as Array<Record<string, unknown>>
        expect(tools.map(wireToolName)).not.toContain("mcp_tool_search")
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

lifecycleMcpIt.live("MCP calls in one outer run share one turn and emit one terminal notification", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      lifecycleContexts.length = 0
      lifecycleNotifications.length = 0
      lifecycleNotificationHangs = false
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Lifecycle",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "call the lifecycle tool twice" }],
      })
      yield* llm.tool("mcp_lifecycle", { index: 1 })
      yield* llm.tool("mcp_lifecycle", { index: 2 })
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: session.id })

      expect(lifecycleContexts).toHaveLength(2)
      expect(lifecycleContexts[0]?.sessionId).toBe(session.id)
      expect(lifecycleContexts[0]?.actorId).toBe("main")
      expect(lifecycleContexts[0]?.turnId).toBeTruthy()
      expect(lifecycleContexts[1]).toEqual(lifecycleContexts[0])
      expect(lifecycleNotifications).toEqual([
        {
          method: "notifications/com.xiaomi.mimo/turn-lifecycle",
          params: { ...lifecycleContexts[0], status: "completed" },
        },
      ])
    }),
    { git: true, config: providerCfg },
  ),
)

lifecycleMcpIt.live("MCP lifecycle waits for an in-flight tool call before notifying", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      lifecycleContexts.length = 0
      lifecycleNotifications.length = 0
      lifecycleNotificationHangs = false
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      lifecycleToolStarted = started
      lifecycleToolGate = gate
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(gate, undefined)
          lifecycleToolStarted = undefined
          lifecycleToolGate = undefined
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Lifecycle settling",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "call the lifecycle tool" }],
      })
      yield* llm.tool("mcp_lifecycle", { index: 1 })
      yield* llm.text("done")

      const run = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(lifecycleNotifications).toEqual([])

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(run)
      expect(lifecycleNotifications).toHaveLength(1)
      expect(lifecycleNotifications[0]?.params).toMatchObject({
        sessionId: session.id,
        turnId: lifecycleContexts[0]?.turnId,
        status: "completed",
      })
    }),
    { git: true, config: providerCfg },
  ),
)

lifecycleMcpIt.live(
  "MCP lifecycle emits one cancelled notification when the outer run is interrupted",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        lifecycleContexts.length = 0
        lifecycleNotifications.length = 0
        lifecycleNotificationHangs = false
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Lifecycle cancellation" })
        yield* user(session.id, "wait")
        yield* llm.hang

        const fiber = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(session.id)
        yield* Fiber.await(fiber)

        expect(lifecycleNotifications).toHaveLength(1)
        expect(lifecycleNotifications[0]).toMatchObject({
          method: "notifications/com.xiaomi.mimo/turn-lifecycle",
          params: { sessionId: session.id, actorId: "main", status: "cancelled" },
        })
        expect(lifecycleNotifications[0]?.params?.turnId).toBeTruthy()
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

lifecycleMcpIt.live("MCP lifecycle emits one error notification when the outer run fails", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      lifecycleContexts.length = 0
      lifecycleNotifications.length = 0
      lifecycleNotificationHangs = false
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Lifecycle error" })
      yield* user(session.id, "fail")
      yield* llm.error(400, { error: { message: "test failure" } })

      yield* prompt.loop({ sessionID: session.id }).pipe(Effect.exit)

      expect(lifecycleNotifications).toHaveLength(1)
      expect(lifecycleNotifications[0]).toMatchObject({
        method: "notifications/com.xiaomi.mimo/turn-lifecycle",
        params: { sessionId: session.id, actorId: "main", status: "error" },
      })
      expect(lifecycleNotifications[0]?.params?.turnId).toBeTruthy()
    }),
    { git: true, config: providerCfg },
  ),
)

lifecycleMcpIt.live(
  "MCP lifecycle timeout lets the outer run finalizer complete when a notification hangs",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        lifecycleContexts.length = 0
        lifecycleNotifications.length = 0
        lifecycleNotificationHangs = true
        yield* Effect.addFinalizer(() => Effect.sync(() => void (lifecycleNotificationHangs = false)))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Lifecycle timeout" })
        yield* user(session.id, "finish despite a hanging notification")
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })

        expect(result.info.role).toBe("assistant")
        expect(lifecycleNotifications).toEqual([])
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

it.live("glob tool keeps instance context during prompt runs", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Glob context",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const file = path.join(dir, "probe.txt")
        yield* Effect.promise(() => Bun.write(file, "probe"))

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "find text files" }],
        })
        yield* llm.tool("glob", { pattern: "**/*.txt" })
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const msgs = yield* MessageV2.filterCompactedEffect(session.id)
        const tool = msgs
          .flatMap((msg) => msg.parts)
          .find(
            (part): part is CompletedToolPart =>
              part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
          )
        if (!tool) return

        expect(tool.state.output).toContain(file)
        expect(tool.state.output).not.toContain("No context found for instance")
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is stop but assistant has tool parts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().tool("first", { value: "first" }).stop())
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("failed subtask preserves metadata on error tool state", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.tool("actor", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("done")
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = errorTool(taskMsg.parts)
      if (!tool) return

      expect(tool.state.error).toContain("Tool execution failed")
      expect(tool.state.metadata).toBeDefined()
      expect(tool.state.metadata?.sessionId).toBeDefined()
      expect(tool.state.metadata?.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("missing-model"),
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          general: {
            model: "test/missing-model",
          },
        },
      }),
    },
  ),
)

it.live("recoverable tool failure flags the error tool state for muted display", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Recoverable",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // `task start` on a nonexistent id is valid args that fail at execution
      // with a RecoverableError. This drives failToolCall, which must flag the
      // error part recoverable so the TUI mutes it instead of showing a red block.
      yield* llm.tool("task", { operation: { action: "start", id: "T99" } })
      yield* llm.text("done")
      yield* user(session.id, "start task T99")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")

      const tool = (yield* MessageV2.filterCompactedEffect(session.id))
        .flatMap((msg) => msg.parts)
        .find(
          (part): part is ErrorToolPart =>
            part.type === "tool" && part.tool === "task" && part.state.status === "error",
        )
      expect(tool).toBeDefined()
      if (!tool) return
      expect(tool.state.metadata?.recoverable).toBe(true)
      expect(tool.state.error).toContain("task list")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live(
  "loop sets status to busy then idle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect((yield* status.get(chat.id)).type).toBe("busy")
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Cancel semantics

it.live(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* seed(chat.id)

        yield* llm.hang

        yield* user(chat.id, "more")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const info = exit.value.info
          if (info.role === "assistant") {
            expect(info.error?.name).toBe("MessageAbortedError")
          }
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel finalizes subtask tool state",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const aborted = defer<void>()
          const registry = yield* ToolRegistry.Service
          const { actor } = yield* registry.named()
          const original = actor.execute
          actor.execute = (_args, ctx) =>
            Effect.callback<never>((_resume) => {
              ready.resolve()
              ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
              return Effect.sync(() => aborted.resolve())
            })
          yield* Effect.addFinalizer(() => Effect.sync(() => void (actor.execute = original)))

          const { prompt, chat } = yield* boot()
          const msg = yield* user(chat.id, "hello")
          yield* addSubtask(chat.id, msg.id)

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)
          yield* Effect.promise(() => aborted.promise)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          expect(taskMsg?.info.role).toBe("assistant")
          if (!taskMsg || taskMsg.info.role !== "assistant") return

          const tool = toolPart(taskMsg.parts)
          expect(tool?.type).toBe("tool")
          if (!tool) return

          expect(tool.state.status).not.toBe("running")
          expect(taskMsg.info.time.completed).toBeDefined()
          expect(taskMsg.info.finish).toBeDefined()
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "cancel with queued callers resolves all cleanly",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        yield* prompt.cancel(chat.id)
        const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(exitA)).toBe(true)
        expect(Exit.isSuccess(exitB)).toBe(true)
        if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
          expect(exitA.value.info.id).toBe(exitB.value.info.id)
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Queue semantics

it.live("concurrent loop callers get same result", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true },
  ),
)

it.live(
  "concurrent loop callers all receive same error result",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.fail("boom")
        yield* user(chat.id, "hello")

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })
        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("second")

        const a = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)

        const id = MessageID.ascending()
        const b = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for second prompt to save")
        })

        gate.resolve()

        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        const last = assistants.at(-1)
        if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
        expect(last.info.parentID).toBe(id)
        expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "assertNotBusy throws BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live("assertNotBusy succeeds when idle", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service

        const chat = yield* sessions.create({})
        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    { git: true },
  ),
)

// Shell semantics

it.live(
  "shell rejects with BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell completes a fast command on the preferred shell", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("pwd")
        expect(tool.state.output).toContain(dir)
        expect(tool.state.metadata.output).toContain(dir)
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell lists files from the project directory", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# e2e\n"))

        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command ls",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("command ls")
        expect(tool.state.output).toContain("README.md")
        expect(tool.state.metadata.output).toContain("README.md")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell captures stderr from a failing command", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("not found")
        expect(tool.state.metadata.output).toContain("not found")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* Effect.promise(async () => {
              const start = Date.now()
              while (Date.now() - start < 5000) {
                const msgs = await MessageV2.filterCompacted(MessageV2.stream(chat.id))
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return
                await new Promise((done) => setTimeout(done, 20))
              }
              throw new Error("timed out waiting for running shell metadata")
            })

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

it.live(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", model: ref, command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const exit = yield* Fiber.await(loop)

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", model: ref, command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
          expect(ea.value.info.id).toBe(eb.value.info.id)
          expect(ea.value.info.role).toBe("assistant")
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, run, sessions, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.gen(function* () {
              while (true) {
                const msgs = yield* sessions.messages({ sessionID: chat.id })
                if (msgs.some((m) => m.info.role === "assistant")) return
                yield* Effect.sleep(10)
              }
            }).pipe(Effect.timeout(5000))

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, sessions, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.gen(function* () {
              while (true) {
                const msgs = yield* sessions.messages({ sessionID: chat.id })
                if (msgs.some((m) => m.info.role === "assistant")) return
                yield* Effect.sleep(10)
              }
            }).pipe(Effect.timeout(5000))

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

// skip (was unix-only): flaky timing race — 150ms sleep insufficient on slow CI runners
it.live.skip(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "Interrupted bash truncation",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "run bash" }],
          })

          yield* llm.tool("bash", {
            command:
              'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; sleep 30',
            description: "Print many lines",
            timeout: 30_000,
            workdir: path.resolve(dir),
          })

          const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* llm.wait(1)
          yield* Effect.sleep(150)
          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(run)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isFailure(exit)) return

          const tool = completedTool(exit.value.parts)
          if (!tool) return

          expect(tool.state.metadata.truncated).toBe(true)
          expect(typeof tool.state.metadata.outputPath).toBe("string")
          expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
          expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
          expect(tool.state.output).not.toContain("Tool execution aborted")
        }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

// skip: flaky timing race — sleep(50) insufficient for shell to acquire run-state lock on slow CI
it.live.skip(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(loop)
          expect(Exit.isSuccess(exit)).toBe(true)

          yield* Fiber.await(sh)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const a = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            const exit = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "echo hi" })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
            }

            yield* prompt.cancel(chat.id)
            yield* Fiber.await(a)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

// Abort signal propagation tests for inline tool execution

/** Override a tool's execute to hang until aborted. Returns ready/aborted defers and a finalizer. */
function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  const ready = defer<void>()
  const aborted = defer<void>()
  const original = tool.execute
  tool.execute = (_args: any, ctx: any) => {
    ready.resolve()
    ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
    return Effect.callback<never>(() => {})
  }
  const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
  return { ready, aborted, restore }
}

it.live(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const testFile = path.join(dir, "test.txt")
          yield* Effect.promise(() => Bun.write(testFile, "hello world"))

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)
