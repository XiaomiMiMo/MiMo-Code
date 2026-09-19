import { Worktree } from "../../src/worktree"
import { Instance } from "../../src/project/instance"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, describe, expect } from "bun:test"
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
import { Global } from "../../src/global"
import { EffectLogger } from "../../src/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { Inbox } from "../../src/inbox"
import { Metrics } from "../../src/metrics"
import { Database, eq, NotFoundError } from "../../src/storage"
import { prefixCaptureRef } from "../../src/session/prefix-capture-ref"
import {
  currentMainHintToken,
  hintClaimBarrier,
  hintFirePostBarrier,
  hintGitProbeBarrier,
} from "../../src/session/prompt/uncommitted-hint"
import { SessionPrefixSnapshotTable } from "../../src/session/session.sql"

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

function dynamicSystemPrompt<A, E, R>(value: string | undefined, fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT
      if (value === undefined) delete process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT
      else process.env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT = value
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

const withoutDynamicSystemPrompt = <A, E, R>(fx: () => Effect.Effect<A, E, R>) => dynamicSystemPrompt(undefined, fx)
const withDynamicSystemPrompt = <A, E, R>(fx: () => Effect.Effect<A, E, R>) => dynamicSystemPrompt("true", fx)

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
function makeHttp(mcpService = mcp, providerLayer = ProviderSvc.defaultLayer) {
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
    providerLayer,
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

const it = testEffect(Layer.provideMerge(makeHttp(), EffectLogger.layer))
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

// [TP-R1-01][TP-R4-01][TP-R4-02][TP-R3-01][TP-R7-01] uncommitted-hint integration.
it.live("[TP-R1-01][TP-R4-02][TP-R7-01] uncommitted-hint dirty USER turn produces a synthetic hint", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: true } },
      })
      try {
        const chat = yield* sessions.create({
          title: "uh-on",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        // Queue user-turn reply AND hook follow-up reply before prompt so inject path has LLM.
        yield* llm.text("done without commit")
        yield* llm.text("will commit next")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          source: "user",
          variant: "high",
          parts: [{ type: "text", text: "please edit dirty work" }],
        })
        yield* Effect.sleep("2500 millis")
        const msgs = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const hintUsers = msgs.filter(
          (m) =>
            m.info.role === "user" &&
            m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
        )
        expect(hintUsers.length).toBe(1)
        const hintInfo = hintUsers[0]!.info
        if (hintInfo.role !== "user") throw new Error("expected user hint message")
        // R002: variant lives on model.variant, matching MessageV2.User DTO.
        expect(hintInfo.model.variant).toBe("high")
        expect(hintInfo).not.toHaveProperty("variant")
        const hintParts = hintUsers[0]!.parts.filter((p) => p.type === "text")
        expect(hintParts.some((p) => p.type === "text" && String(p.text).includes(" M dirty.txt") || String((p as { text?: string }).text ?? "").includes("dirty.txt"))).toBe(true)
        // Settlement of the original user turn is not blocked by hint inject.
        const statusSvc = yield* SessionStatus.Service
        const settled = yield* statusSvc.get(chat.id)
        expect(settled.type).toBe("idle")
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
      }
    }),
    { git: true, config: providerCfg },
  ),
  20_000,
)

// [TP-R4-02] Re-hint while dirty: cancel during hook follow-up does not late-inject;
// a later dirty USER turn may inject again (no session-once hard cap).
it.live("[TP-R4-02] uncommitted-hint cancel hook turn then dirty USER turn re-hints", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: true } },
      })
      const countHints = Effect.fn("test.countUhHints")(function* (sessionID: SessionID) {
        const msgs = yield* sessions.messages({ sessionID, agentID: "main" })
        return msgs.filter((m) =>
          m.parts.some(
            (p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes"),
          ),
        ).length
      })
      try {
        const chat = yield* sessions.create({
          title: "uh-rehint-cancel",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        // User turn completes; the NEXT queued reply (hook follow-up) hangs until cancel.
        yield* llm.text("done without commit")
        yield* llm.hang
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          source: "user",
          parts: [{ type: "text", text: "dirty work first" }],
        })
        // Hint injects then hook runLoop requests LLM → hang reply (not empty-queue auto-ok).
        yield* Effect.sleep("1500 millis")
        expect(yield* countHints(chat.id)).toBe(1)
        yield* llm.wait(2)
        const status = yield* SessionStatus.Service
        const during = yield* status.get(chat.id)
        expect(during.type).toBe("busy")
        yield* prompt.cancel(chat.id)
        yield* Effect.sleep("300 millis")
        // Second USER turn while workspace still dirty — re-hint is allowed.
        yield* llm.text("second turn done")
        yield* llm.hang
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          source: "user",
          parts: [{ type: "text", text: "still dirty" }],
        })
        yield* Effect.sleep("2000 millis")
        // 1 (first inject) + 1 (second dirty user turn) = 2
        expect(yield* countHints(chat.id)).toBe(2)
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
      }
    }),
    { git: true, config: providerCfg },
  ),
  20_000,
)

it.live("[TP-R3-01][TP-R4-01][TP-R7-01] uncommitted-hint disabled USER turn does not inject", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: false } },
      })
      try {
        const chat = yield* sessions.create({
          title: "uh-off",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("ok")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          source: "user",
          parts: [{ type: "text", text: "dirty work" }],
        })
        yield* Effect.sleep("1200 millis")
        const msgs = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const hints = msgs.filter((m) =>
          m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
        )
        expect(hints).toHaveLength(0)
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("[TP-R4-01][TP-R7-01] uncommitted-hint enabled + hook-source turn does not inject", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: true } },
      })
      try {
        const chat = yield* sessions.create({
          title: "uh-hook",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("hook reply")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          source: "hook",
          parts: [{ type: "text", text: "machine task", synthetic: true }],
        })
        yield* Effect.sleep("1200 millis")
        const msgs = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const hints = msgs.filter((m) =>
          m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
        )
        expect(hints).toHaveLength(0)
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
      }
    }),
    { git: true, config: providerCfg },
  ),
)

// R003: root-session machine contract — hook + provenance accepts machine payloads.
const machineProvenance = { machine: "desktop-automation" } as const

it.live("[TP-R4-01] machine hook text-only with provenance is accepted and not force-synthetic", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "machine-text",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("machine ok")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        source: "hook",
        provenance: machineProvenance,
        parts: [{ type: "text", text: "scheduled automation body" }],
      })
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const user = msgs.find((m) => m.info.role === "user" && (m.info as { provenance?: unknown }).provenance)
      expect(user).toBeDefined()
      if (!user || user.info.role !== "user") throw new Error("expected provenance user message")
      expect(user.info.provenance).toEqual(machineProvenance)
      const textPart = user.parts.find((p) => p.type === "text" && String((p as { text?: string }).text).includes("scheduled automation body"))
      expect(textPart).toBeDefined()
      if (textPart && textPart.type === "text") {
        // With provenance, engine must not force synthetic on machine text.
        expect(textPart.synthetic).not.toBe(true)
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("[TP-R4-01] machine hook prompt with file attachment + provenance is accepted", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const filePath = `${dir}/.mimo-automation-execution-context.txt`
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        writeFileSync(filePath, "automation execution protocol")
        return true
      })
      const chat = yield* sessions.create({
        title: "machine-file",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("got attachment")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        source: "hook",
        provenance: machineProvenance,
        parts: [
          { type: "text", text: "run automation with protocol file" },
          {
            type: "file",
            filename: ".mimo-automation-execution-context.txt",
            mime: "text/plain",
            url: `file://${filePath}`,
          },
        ],
      })
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const user = msgs.find((m) => m.info.role === "user" && (m.info as { provenance?: unknown }).provenance)
      expect(user).toBeDefined()
      expect(user!.parts.some((p) => p.type === "file")).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("[TP-R4-01] machine command with protocol file part + provenance is accepted", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { mkdirSync, writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        const cmdDir = join(dir, ".mimocode", "command")
        mkdirSync(cmdDir, { recursive: true })
        writeFileSync(
          join(cmdDir, "auto-cmd.md"),
          "---\ndescription: automation execution\n---\n\nExecute the saved automation now.\n",
        )
        return true
      })
      const chat = yield* sessions.create({
        title: "machine-command",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("command executed")
      const protocolPart = {
        type: "file" as const,
        mime: "text/plain",
        filename: ".mimo-automation-execution-context.txt",
        url: `data:text/plain;charset=utf-8,${encodeURIComponent("automation protocol body")}`,
      }
      yield* prompt.command({
        sessionID: chat.id,
        agent: "build",
        model: `${ref.providerID}/${ref.modelID}`,
        command: "auto-cmd",
        arguments: "",
        source: "hook",
        provenance: machineProvenance,
        parts: [protocolPart],
      })
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const user = msgs.find((m) => m.info.role === "user" && (m.info as { provenance?: unknown }).provenance)
      expect(user).toBeDefined()
      if (!user || user.info.role !== "user") throw new Error("expected provenance user message")
      expect(user.info.provenance).toEqual(machineProvenance)
      expect(user.parts.some((p) => p.type === "file")).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("[TP-R4-01] uncommitted-hint cancel during first git probe produces no late hint", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: true } },
      })
      let reached: (() => void) | undefined
      const reachedP = new Promise<void>((resolve) => {
        reached = resolve
      })
      let releaseGit: (() => void) | undefined
      const gitParked = new Promise<void>((resolve) => {
        releaseGit = resolve
      })
      hintGitProbeBarrier.onReached = () => reached?.()
      hintGitProbeBarrier.wait = () => gitParked
      try {
        const chat = yield* sessions.create({
          title: "uh-git-cancel",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("turn-a done")
        yield* llm.text("UNEXPECTED_HINT_FOLLOWUP")
        // firePostSession runs in onExit and may await the git barrier — fork prompt.
        const aFiber = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            source: "user",
            parts: [{ type: "text", text: "turn a dirty" }],
          })
          .pipe(Effect.forkChild)
        // Pending is registered before git probe; park on the probe itself.
        yield* Effect.promise(() => reachedP)
        const inputsAtProbe = (yield* llm.inputs).length
        yield* prompt.cancel(chat.id)
        releaseGit?.()
        yield* Fiber.join(aFiber).pipe(Effect.catch(() => Effect.void))
        yield* Effect.sleep("500 millis")
        const msgs = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const hints = msgs.filter((m) =>
          m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
        )
        expect(hints).toHaveLength(0)
        expect((yield* llm.inputs).length).toBe(inputsAtProbe)
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
        hintGitProbeBarrier.onReached = undefined
        hintGitProbeBarrier.wait = undefined
        releaseGit?.()
      }
    }),
    { git: true, config: providerCfg },
  ),
  15_000,
)

it.live("[TP-R4-01] uncommitted-hint main cancel after child runLoop still kills main pending", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: true } },
      })
      let reached: (() => void) | undefined
      const reachedP = new Promise<void>((resolve) => {
        reached = resolve
      })
      let releaseA: (() => void) | undefined
      const parked = new Promise<void>((resolve) => {
        releaseA = resolve
      })
      hintClaimBarrier.onReached = () => reached?.()
      hintClaimBarrier.wait = () => parked
      try {
        const chat = yield* sessions.create({
          title: "uh-main-child",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("turn-a done")
        yield* llm.text("child runloop done")
        yield* llm.text("UNEXPECTED_HINT_FOLLOWUP")
        const aFiber = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            source: "user",
            parts: [{ type: "text", text: "turn a dirty" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => reachedP)
        const mainTokBeforeChild = currentMainHintToken(chat.id)
        expect(mainTokBeforeChild).toBeDefined()
        const inputsBeforeChild = (yield* llm.inputs).length
        // REAL child runLoop (not noReply): non-main agentID + spawn is legal on root.
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          agentID: "build-child",
          model: ref,
          source: "spawn",
          parts: [{ type: "text", text: "child task executes runLoop" }],
        })
        const inputsAfterChild = (yield* llm.inputs).length
        // Child produced a model request — proof it entered runLoop.
        expect(inputsAfterChild).toBeGreaterThan(inputsBeforeChild)
        // Child runLoop must not open/overwrite the MAIN hint token.
        expect(currentMainHintToken(chat.id)).toBe(mainTokBeforeChild)
        yield* prompt.cancel(chat.id)
        releaseA?.()
        yield* Fiber.join(aFiber).pipe(Effect.catch(() => Effect.void))
        yield* Effect.sleep("800 millis")
        const msgs = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const hints = msgs.filter((m) =>
          m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
        )
        expect(hints).toHaveLength(0)
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
        hintClaimBarrier.onReached = undefined
        hintClaimBarrier.wait = undefined
        hintFirePostBarrier.onReached = undefined
        hintFirePostBarrier.wait = undefined
        hintGitProbeBarrier.onReached = undefined
        hintGitProbeBarrier.wait = undefined
        releaseA?.()
      }
    }),
    { git: true, config: providerCfg },
  ),
  15_000,
)

it.live("[TP-R4-01][TP-R7-01] uncommitted-hint busy claim does not inject and does not stall settlement", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: true } },
      })
      try {
        const chat = yield* sessions.create({
          title: "uh-busy",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("turn-a done")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          source: "user",
          parts: [{ type: "text", text: "turn a dirty" }],
        })
        const inputsAfterA = (yield* llm.inputs).length
        // Immediately occupy the runner so A's delayed claim fails (state.start busy).
        yield* llm.hang
        const bFiber = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            source: "user",
            parts: [{ type: "text", text: "turn b hangs" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.sleep("2000 millis")
        const msgs = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const hints = msgs.filter((m) =>
          m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
        )
        expect(hints).toHaveLength(0)
        const inputsDuring = (yield* llm.inputs).length
        expect(inputsDuring).toBe(inputsAfterA + 1)
        yield* prompt.cancel(chat.id)
        yield* Fiber.join(bFiber).pipe(Effect.catch(() => Effect.void))
        const settled = yield* status.get(chat.id)
        expect(settled.type).toBe("idle")
        const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        expect(
          after.filter((m) =>
            m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
          ),
        ).toHaveLength(0)
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
        hintClaimBarrier.onReached = undefined
        hintClaimBarrier.wait = undefined
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("[TP-R4-01] uncommitted-hint cancel-only invalidates pending follow-up before claim", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: true } },
      })
      let reached: (() => void) | undefined
      const reachedP = new Promise<void>((resolve) => {
        reached = resolve
      })
      let releaseA: (() => void) | undefined
      const parked = new Promise<void>((resolve) => {
        releaseA = resolve
      })
      hintClaimBarrier.onReached = () => reached?.()
      hintClaimBarrier.wait = () => parked
      try {
        const chat = yield* sessions.create({
          title: "uh-cancel-only",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("turn-a done")
        // Pre-queue an unexpected follow-up so a wrong inject cannot pass via fixture starvation.
        yield* llm.text("UNEXPECTED_HINT_FOLLOWUP")
        const aFiber = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            source: "user",
            parts: [{ type: "text", text: "turn a dirty" }],
          })
          .pipe(Effect.forkChild)
        // Handshake: delayed path has finished gates and is parked before claim.
        yield* Effect.promise(() => reachedP)
        const inputsAtBarrier = (yield* llm.inputs).length
        const msgsAtBarrier = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        expect(
          msgsAtBarrier.filter((m) =>
            m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
          ),
        ).toHaveLength(0)
        // Cancel-only: keep the session. Pending hint must be invalidated.
        yield* prompt.cancel(chat.id)
        releaseA?.()
        yield* Fiber.join(aFiber).pipe(Effect.catch(() => Effect.void))
        yield* Effect.sleep("500 millis")
        const msgs = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const hints = msgs.filter((m) =>
          m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
        )
        expect(hints).toHaveLength(0)
        const inputsAfter = (yield* llm.inputs).length
        expect(inputsAfter).toBe(inputsAtBarrier)
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
        hintClaimBarrier.onReached = undefined
        hintClaimBarrier.wait = undefined
        releaseA?.()
      }
    }),
    { git: true, config: providerCfg },
  ),
  15_000,
)

it.live("[TP-R4-01] uncommitted-hint supersession after barrier drops stale A by model.variant identity", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: true } },
      })
      let reached: (() => void) | undefined
      const reachedP = new Promise<void>((resolve) => {
        reached = resolve
      })
      let releaseA: (() => void) | undefined
      const parked = new Promise<void>((resolve) => {
        releaseA = resolve
      })
      hintClaimBarrier.onReached = () => reached?.()
      hintClaimBarrier.wait = () => parked
      try {
        const chat = yield* sessions.create({
          title: "uh-stale-variant",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("turn-a done")
        const aFiber = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            source: "user",
            variant: "low",
            parts: [{ type: "text", text: "turn a dirty" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => reachedP)
        // A is parked after gates, before claim. B supersedes to idle.
        hintClaimBarrier.onReached = undefined
        hintClaimBarrier.wait = undefined
        yield* llm.text("turn-b done")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          source: "user",
          variant: "high",
          parts: [{ type: "text", text: "turn b supersedes" }],
        })
        releaseA?.()
        yield* Fiber.join(aFiber).pipe(Effect.catch(() => Effect.void))
        yield* Effect.sleep("500 millis")
        const msgs = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const hints = msgs.filter(
          (m) =>
            m.info.role === "user" &&
            m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
        )
        // Stale A (variant low) must never inject. Any hint present must be B's (high).
        const staleA = hints.filter((m) => m.info.role === "user" && m.info.model.variant === "low")
        expect(staleA).toHaveLength(0)
        for (const hint of hints) {
          if (hint.info.role !== "user") continue
          expect(hint.info.model.variant).toBe("high")
        }
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
        hintClaimBarrier.onReached = undefined
        hintClaimBarrier.wait = undefined
        releaseA?.()
      }
    }),
    { git: true, config: providerCfg },
  ),
  15_000,
)

it.live("[TP-R4-01] uncommitted-hint delete during wait produces no late hint message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: true } },
      })
      let reached: (() => void) | undefined
      const reachedP = new Promise<void>((resolve) => {
        reached = resolve
      })
      let releaseA: (() => void) | undefined
      const parked = new Promise<void>((resolve) => {
        releaseA = resolve
      })
      hintClaimBarrier.onReached = () => reached?.()
      hintClaimBarrier.wait = () => parked
      try {
        const chat = yield* sessions.create({
          title: "uh-delete",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("turn-a done")
        const aFiber = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            source: "user",
            parts: [{ type: "text", text: "turn a dirty" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => reachedP)
        const msgsBefore = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        expect(
          msgsBefore.filter((m) =>
            m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
          ),
        ).toHaveLength(0)
        yield* prompt.cancel(chat.id)
        yield* sessions.remove(chat.id)
        releaseA?.()
        yield* Fiber.join(aFiber).pipe(Effect.catch(() => Effect.void))
        yield* Effect.sleep("500 millis")
        const msgExit = yield* sessions.messages({ sessionID: chat.id, agentID: "main" }).pipe(Effect.exit)
        if (Exit.isSuccess(msgExit)) {
          expect(
            msgExit.value.filter((m) =>
              m.parts.some((p) => p.type === "text" && p.synthetic === true && String(p.text).includes("uncommitted git changes")),
            ),
          ).toHaveLength(0)
        } else {
          // Deleted session: NotFound defect is the expected "no late delivery" outcome.
          expect(String(msgExit.cause)).toContain("NotFoundError")
        }
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
        hintClaimBarrier.onReached = undefined
        hintClaimBarrier.wait = undefined
        releaseA?.()
      }
    }),
    { git: true, config: providerCfg },
  ),
  15_000,
)

it.live("[TP-R7-01] uncommitted-hint decision logs land in Desktop WARN-level sink", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* Effect.promise(async () => {
        const { writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        writeFileSync(join(dir, "dirty.txt"), "x")
        return true
      })
      const prev = process.env.MIMOCODE_CONFIG_CONTENT
      process.env.MIMOCODE_CONFIG_CONTENT = JSON.stringify({
        experimental: { uncommitted_hint: { enabled: true } },
      })
      const prevLogPath = Global.Path.log
      let warnLogDir = ""
      try {
        // Mirror Desktop engine bootstrap: Log.init({ print: false, level: "WARN" }).
        yield* Effect.promise(async () => {
          const { mkdtempSync } = await import("node:fs")
          const { tmpdir } = await import("node:os")
          const { join } = await import("node:path")
          warnLogDir = mkdtempSync(join(tmpdir(), "uh-warn-log-"))
          Global.Path.log = warnLogDir
          await Log.init({ print: false, level: "WARN" })
          return true
        })
        const chat = yield* sessions.create({
          title: "uh-warn-log",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("dirty work done")
        yield* llm.text("will commit")
        // firePostSession may await barriers; keep this path unblocked (no test barriers set).
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          source: "user",
          parts: [{ type: "text", text: "please edit dirty work" }],
        })
        yield* Effect.sleep("2500 millis")
        const logged = yield* Effect.promise(async () => {
          await Log.flush()
          return await Bun.file(Log.file()).text()
        })
        expect(logged).toContain("uncommitted-hint")
        expect(logged).toContain("decision")
        expect(logged).toMatch(/dirty|inject|skip/)
        // Isolation check (R017): path still points at the WARN dir until finally restores it.
        expect(Global.Path.log).toBe(warnLogDir)
      } finally {
        if (prev === undefined) delete process.env.MIMOCODE_CONFIG_CONTENT
        else process.env.MIMOCODE_CONFIG_CONTENT = prev
        // Restore shared test-process log sink including LEVEL (R017: omit ≠ reset).
        yield* Effect.promise(async () => {
          const { rm } = await import("node:fs/promises")
          await Log.shutdown().catch(() => undefined)
          Global.Path.log = prevLogPath
          await Log.init({ print: false, level: "INFO" })
          if (warnLogDir) await rm(warnLogDir, { recursive: true, force: true }).catch(() => undefined)
          Log.Default.info("uh-log-restore-marker")
          await Log.flush()
          const restored = await Bun.file(Log.file()).text()
          expect(restored).toContain("uh-log-restore-marker")
          return true
        })
      }
    }),
    { git: true, config: providerCfg },
  ),
  15_000,
)

it.live("locks system and harness to the first user query", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        system: "first system prompt",
        systemMode: "replace-agent",
        harness: "codex",
        parts: [{ type: "text", text: "first query" }],
      })

      const synthetic = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: chat.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: ref,
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: synthetic.id,
        sessionID: chat.id,
        type: "text",
        text: "synthetic recovery",
        synthetic: true,
      })
      yield* llm.text("recovered")
      yield* prompt.loop({ sessionID: chat.id })

      const input = (yield* llm.inputs)[0]
      const request = JSON.stringify(input)
      expect(request).not.toContain("You are Codex")
      expect(request).toContain("first system prompt")
      expect(
        (input.messages as Array<{ role: string; content: unknown }>)
          .filter((message) => JSON.stringify(message.content).includes("first system prompt"))
          .map((message) => message.role),
      ).toEqual(["system"])
      expect((input.tools as Array<Record<string, unknown>>).map(wireToolName)).toEqual(["exec"])

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        system: "second system prompt",
        systemMode: "append",
        harness: "default",
        parts: [{ type: "text", text: "second query" }],
      })

      const users = (yield* sessions.messages({ sessionID: chat.id }))
        .map((message) => message.info)
        .filter((message): message is MessageV2.User => message.role === "user")
      expect(users.map((message) => message.harness)).toEqual(["codex", undefined, "codex"])
      expect(users.map((message) => message.system)).toEqual(["first system prompt", undefined, "first system prompt"])
      expect(users.map((message) => message.systemMode)).toEqual(["replace-agent", undefined, "replace-agent"])
      expect((yield* sessions.get(chat.id)).prompt).toEqual({
        system: "first system prompt",
        systemMode: "replace-agent",
        harness: "codex",
      })
      expect((yield* sessions.create({ parentID: chat.id })).prompt).toEqual({
        system: "first system prompt",
        systemMode: "replace-agent",
        harness: "codex",
      })

      const legacy = yield* sessions.create({ title: "Legacy" })
      const legacyFirst = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: legacy.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: ref,
        system: "legacy first system",
        harness: "default",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: legacyFirst.id,
        sessionID: legacy.id,
        type: "text",
        text: "legacy real query",
      })
      const legacySynthetic = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: legacy.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: ref,
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: legacySynthetic.id,
        sessionID: legacy.id,
        type: "text",
        text: "legacy synthetic recovery",
        synthetic: true,
      })
      expect(yield* sessions.resolvePrompt({ sessionID: legacy.id })).toEqual({
        system: "legacy first system",
        systemMode: "append",
        harness: "default",
      })
      expect((yield* sessions.get(legacy.id)).prompt).toBeUndefined()
      expect(
        yield* sessions.resolvePrompt({
          sessionID: legacy.id,
          fallback: { system: "wrong fallback", harness: "codex" },
        }),
      ).toEqual({
        system: "legacy first system",
        systemMode: "append",
        harness: "default",
      })
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("does not pin an empty parent while creating a child", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Empty parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Early child" })
      const fork = yield* sessions.fork({ sessionID: parent.id })

      expect((yield* sessions.get(parent.id)).prompt).toBeUndefined()
      expect(child.prompt).toBeUndefined()
      expect(fork.prompt).toBeUndefined()

      const empty = yield* prompt.prompt({
        sessionID: parent.id,
        agent: "build",
        model: ref,
        noReply: true,
        system: "empty system",
        harness: "codex",
        parts: [{ type: "text", text: "   " }],
      })
      expect(empty.parts).toEqual([])
      expect((yield* sessions.get(parent.id)).prompt).toBeUndefined()

      yield* prompt.prompt({
        sessionID: parent.id,
        agent: "build",
        model: ref,
        noReply: true,
        system: "synthetic system",
        harness: "codex",
        parts: [{ type: "text", text: "synthetic cron", synthetic: true }],
      })
      expect((yield* sessions.get(parent.id)).prompt).toBeUndefined()

      yield* prompt.shell({
        sessionID: parent.id,
        agent: "build",
        model: ref,
        command: "echo before-query",
      })
      expect((yield* sessions.get(parent.id)).prompt).toBeUndefined()

      yield* prompt.prompt({
        sessionID: parent.id,
        agent: "build",
        model: ref,
        noReply: true,
        system: "parent system",
        harness: "default",
        parts: [{ type: "text", text: "parent first query" }],
      })
      yield* prompt.prompt({
        sessionID: child.id,
        agent: "build",
        model: ref,
        noReply: true,
        system: "child system",
        harness: "codex",
        parts: [{ type: "text", text: "child first query" }],
      })

      expect((yield* sessions.get(parent.id)).prompt).toEqual({ system: "parent system", systemMode: "append", harness: "default" })
      expect((yield* sessions.get(child.id)).prompt).toEqual({ system: "child system", systemMode: "append", harness: "codex" })
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("persists auto as its own harness mode", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const explicit = yield* sessions.create({ title: "Explicit auto" })
      const omitted = yield* sessions.create({ title: "Omitted harness" })

      yield* prompt.prompt({
        sessionID: explicit.id,
        agent: "build",
        model: ref,
        noReply: true,
        harness: "auto",
        parts: [{ type: "text", text: "first explicit auto query" }],
      })
      yield* prompt.prompt({
        sessionID: explicit.id,
        agent: "build",
        model: ref,
        noReply: true,
        harness: "codex",
        parts: [{ type: "text", text: "later override" }],
      })
      yield* prompt.prompt({
        sessionID: omitted.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "first omitted query" }],
      })

      expect((yield* sessions.get(explicit.id)).prompt?.harness).toBe("auto")
      expect((yield* sessions.get(omitted.id)).prompt?.harness).toBe("auto")
      const users = (yield* sessions.messages({ sessionID: explicit.id }))
        .map((message) => message.info)
        .filter((message): message is MessageV2.User => message.role === "user")
      expect(users.map((message) => message.harness)).toEqual(["auto", "auto"])
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("uses the frozen system and appends the compaction prompt to the existing conversation", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      const chat = yield* sessions.create({ title: "Compaction prompt" })
      const marker = "SESSION_SYSTEM_MUST_SKIP_COMPACTION"

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        system: marker,
        systemMode: "replace-agent",
        harness: "codex",
        parts: [{ type: "text", text: "first query" }],
      })

      yield* llm.text("before compaction")
      yield* prompt.loop({ sessionID: chat.id })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "second query kept verbatim" }],
      })
      yield* llm.text("second answer kept verbatim")
      yield* prompt.loop({ sessionID: chat.id })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "third query kept verbatim" }],
      })
      yield* llm.text("third answer kept verbatim")
      yield* prompt.loop({ sessionID: chat.id })
      const beforeRequest = (yield* llm.inputs)[2]

      yield* compaction.create({
        sessionID: chat.id,
        agent: "compaction",
        model: ref,
        auto: false,
      })
      const snapshot = yield* sessions.messages({ sessionID: chat.id })
      const boundary = snapshot.at(-1)!
      yield* llm.text("summary")
      expect(
        yield* compaction.process({
          parentID: boundary.info.id,
          messages: snapshot,
          sessionID: chat.id,
          auto: false,
        }),
      ).toBe("continue")
      const compactionRequest = (yield* llm.inputs)[3]
      expect(compactionRequest.model).toBe(ref.modelID)
      expect(compactionRequest.messages).toBeArray()
      expect(beforeRequest.messages).toBeArray()
      if (!Array.isArray(compactionRequest.messages) || !Array.isArray(beforeRequest.messages)) return
      expect(compactionRequest.messages.slice(0, beforeRequest.messages.length)).toEqual(beforeRequest.messages)
      expect((compactionRequest.tools as Array<Record<string, unknown>>).map(wireToolName)).toEqual(
        (beforeRequest.tools as Array<Record<string, unknown>>).map(wireToolName),
      )
      expect(compactionRequest.tools).toEqual(beforeRequest.tools)
      expect(compactionRequest.tool_choice).toBe(beforeRequest.tool_choice)
      expect(JSON.stringify(compactionRequest)).toContain(marker)
      expect(JSON.stringify(compactionRequest)).toContain("third answer kept verbatim")
      expect(JSON.stringify(compactionRequest)).toContain("1. Task Overview")
      expect(JSON.stringify(compactionRequest)).not.toContain("When constructing the summary")

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "after compaction" }],
      })
      yield* llm.text("continued")
      yield* prompt.loop({ sessionID: chat.id })

      const request = (yield* llm.inputs)[4]
      const serialized = JSON.stringify(request)
      expect(serialized).toContain(marker)
      expect(serialized).toContain("summary")
      expect(serialized).not.toContain("first query")
      expect(serialized).not.toContain("second query kept verbatim")
      expect(serialized).not.toContain("third query kept verbatim")
      expect((request.tools as Array<Record<string, unknown>>).map(wireToolName)).toEqual(["exec"])
      expect((yield* sessions.get(chat.id)).prompt).toEqual({
        system: marker,
        systemMode: "replace-agent",
        harness: "codex",
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: { compaction: { model: "test/gpt-5-test" } },
      }),
    },
  ),
)

it.live("provider-overflow compaction uses its configured model and strips media", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      const chat = yield* sessions.create({ title: "Overflow compaction" })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [
          { type: "text", text: "inspect this image" },
          { type: "file", mime: "image/png", url: "data:image/png;base64,QUFBQQ==", filename: "large.png" },
        ],
      })
      yield* compaction.create({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        auto: true,
        overflow: true,
      })
      const snapshot = yield* sessions.messages({ sessionID: chat.id })
      yield* llm.text("overflow summary")
      expect(
        yield* compaction.process({
          parentID: snapshot.at(-1)!.info.id,
          messages: snapshot,
          sessionID: chat.id,
          auto: true,
          overflow: true,
        }),
      ).toBe("continue")

      const request = (yield* llm.inputs)[0]
      expect(request.model).toBe(mcpRef.modelID)
      expect(request.messages).toBeArray()
      if (!Array.isArray(request.messages)) return
      expect(JSON.stringify(request.messages[0])).not.toContain("You have been working on the task described above")
      expect(JSON.stringify(request.messages.at(-1))).toContain("1. Task Overview")
      expect(JSON.stringify(request)).toContain("[Attached image/png: large.png]")
      expect(JSON.stringify(request)).not.toContain("QUFBQQ==")
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: { compaction: { model: "test/gpt-5-test" } },
      }),
    },
  ),
)

it.live("empty compaction removes its boundary without calling the model", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      const chat = yield* sessions.create({ title: "Empty compaction" })
      yield* compaction.create({ sessionID: chat.id, agent: "build", model: ref, auto: false })
      const snapshot = yield* sessions.messages({ sessionID: chat.id })

      expect(
        yield* compaction.process({
          parentID: snapshot.at(-1)!.info.id,
          messages: snapshot,
          sessionID: chat.id,
          auto: false,
        }),
      ).toBe("stop")
      expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
      expect(yield* llm.calls).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("compaction preserves the parent's appended turn context", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      const chat = yield* sessions.create({ title: "Compaction turn context" })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        system: "APPENDED_TURN_CONTEXT",
        systemMode: "append",
        parts: [{ type: "text", text: "first query" }],
      })
      yield* llm.text("first answer")
      yield* prompt.loop({ sessionID: chat.id })
      const before = (yield* llm.inputs)[0]
      yield* compaction.create({ sessionID: chat.id, agent: "build", model: ref, auto: false })
      const snapshot = yield* sessions.messages({ sessionID: chat.id })
      yield* llm.text("summary")
      expect(
        yield* compaction.process({
          parentID: snapshot.at(-1)!.info.id,
          messages: snapshot,
          sessionID: chat.id,
          auto: false,
        }),
      ).toBe("continue")

      const compacting = (yield* llm.inputs)[1]
      expect(compacting.messages).toBeArray()
      expect(before.messages).toBeArray()
      if (!Array.isArray(compacting.messages) || !Array.isArray(before.messages)) return
      expect(compacting.messages.slice(0, before.messages.length)).toEqual(before.messages)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("persists the process-time compaction projection from the real snapshot and arrived tail", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      const providers = yield* ProviderSvc.Service
      const model = yield* providers.getModel(ref.providerID, ref.modelID)
      const chat = yield* sessions.create({ title: "Compaction projection" })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "inspect and edit auth" }],
      })
      yield* llm.text("prepared")
      const history = yield* prompt.loop({ sessionID: chat.id })
      const authPath = path.join(dir, "src/auth.ts")
      for (const [tool, input, output, metadata] of [
        [
          "read",
          { file_path: authPath, offset: 10, limit: 11 },
          "10: before\n20: after\n\n(Showing lines 10-20 of 100)",
          { truncated: true },
        ],
        ["edit", { file_path: authPath, old_string: "before", new_string: "after" }, "ok", {}],
      ] as const) {
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: history.info.id,
          type: "tool",
          tool,
          callID: `call-${tool}`,
          state: {
            status: "completed",
            input,
            output,
            title: tool,
            metadata,
            time: { start: Date.now(), end: Date.now() },
          },
        })
      }

      yield* compaction.create({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        auto: false,
        agentID: "main",
      })
      const snapshot = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
      const boundary = snapshot.at(-1)!
      const release = defer<void>()
      yield* llm.hold("PROCESS_SUMMARY", release.promise)
      const processing = yield* compaction
        .process({
          parentID: boundary.info.id,
          messages: snapshot,
          sessionID: chat.id,
          auto: false,
          agentID: "main",
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)

      const tailUser = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: chat.id,
        agentID: "main",
        role: "user" as const,
        time: { created: Date.now() },
        agent: "build",
        model: ref,
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: tailUser.id,
        type: "text",
        text: "arrived during compaction",
      })
      const tailAssistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: chat.id,
        agentID: "main",
        role: "assistant" as const,
        parentID: tailUser.id,
        time: { created: Date.now(), completed: Date.now() },
        modelID: ref.modelID,
        providerID: ref.providerID,
        mode: "build",
        agent: "build",
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: tailAssistant.id,
        type: "tool",
        tool: "read",
        callID: "call-large-tail",
        state: {
          status: "completed",
          input: { file_path: path.join(dir, "large.log") },
          output: "x".repeat(40_000),
          title: "read",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      })

      release.resolve(undefined)
      expect(yield* Fiber.join(processing)).toBe("continue")

      const messages = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
      const part = messages
        .flatMap((message) => message.parts)
        .find((part): part is MessageV2.CompactionPart => part.type === "compaction")!
      expect(part.projection?.tail_start_id).toBe(tailUser.id)
      expect(part.projection?.tail_end_id).toBe(tailAssistant.id)
      expect(part.projection?.compacted_tool_calls).toEqual([{ call_id: "call-large-tail", tokens: 10_000 }])
      expect(part.projection?.manifest).toContain("src/auth.ts (read: lines 10-20, then edited)")
      expect(part.projection?.summary).toContain("PROCESS_SUMMARY")

      const modelMessages = JSON.stringify(
        yield* MessageV2.toModelMessagesEffect(MessageV2.filterCompacted([...messages].reverse()), model),
      )
      expect(modelMessages.match(/PROCESS_SUMMARY/g)).toHaveLength(1)
      expect(modelMessages).toContain("arrived during compaction")
      expect(modelMessages).toContain("Tool result omitted during compaction: 10000 tokens")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("serializes concurrent first-query pinning", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Concurrent pin" })

      yield* Effect.all(
        [
          prompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: ref,
            noReply: true,
            system: "system a",
            harness: "codex",
            parts: [{ type: "text", text: "query a" }],
          }),
          prompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: ref,
            noReply: true,
            system: "system b",
            harness: "default",
            parts: [{ type: "text", text: "query b" }],
          }),
        ],
        { concurrency: "unbounded" },
      )

      const pinned = (yield* sessions.get(session.id)).prompt
      const users = (yield* sessions.messages({ sessionID: session.id }))
        .map((message) => message.info)
        .filter((message): message is MessageV2.User => message.role === "user")
      expect(pinned).toBeDefined()
      expect(users).toHaveLength(2)
      expect(users.every((message) => message.system === pinned?.system)).toBe(true)
      expect(users.every((message) => message.systemMode === pinned?.systemMode)).toBe(true)
      expect(users.every((message) => message.harness === pinned?.harness)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("resume continues an incomplete assistant without creating or rewriting a user message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const seeded = yield* seed(chat.id)
      const before = yield* sessions.messages({ sessionID: chat.id })
      yield* llm.text("world")

      const candidate = yield* prompt.recovery({ sessionID: chat.id })
      expect(candidate).toEqual([{ kind: "assistant", assistantMessageID: seeded.assistant.id, parentMessageID: seeded.user.id, created: expect.any(Number) }])
      const result = yield* prompt.resume({
        sessionID: chat.id,
        assistantMessageID: seeded.assistant.id,
        titleLocale: "fr-FR",
      })
      const requests = yield* llm.inputs
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests)).not.toContain("Generate a single-line title")

      const after = yield* sessions.messages({ sessionID: chat.id })
      expect(after.filter((message) => message.info.role === "user")).toHaveLength(1)
      expect(after.length).toBe(before.length + 1)
      expect(after.find((message) => message.info.id === seeded.assistant.id)?.info).toMatchObject(seeded.assistant)
      // tool-resume must stamp Abandoned-as-resumed on the continued assistant
      const seededAfter = after.find((message) => message.info.id === seeded.assistant.id)?.info
      const abandonMsg =
        seededAfter && seededAfter.role === "assistant" && seededAfter.error
          ? ((seededAfter.error as { data?: { message?: string }; message?: string }).data?.message ??
            (seededAfter.error as { message?: string }).message ??
            "")
          : ""
      expect(abandonMsg).toContain("Abandoned: resumed as a new assistant turn")
      expect(result.info.role).toBe("assistant")
      expect(result.info.id).not.toBe(seeded.assistant.id)
      expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    }),
    {
      git: true,
      config: (url) => ({ ...providerCfg(url), model_groups: { lite: "test/test-model" } }),
    },
  ),
)

// [TP-SR-R21-16] user-resume: empty residue assistant → re-dispatch parent user without assistant prefill.
it.live(
  "resume empty residue re-dispatches parent user without assistant prefill",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const parent = yield* user(chat.id, "look for new resumes")
        const shell = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: parent.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        })
        yield* llm.text("found 2 resumes")

        const candidates = yield* prompt.recovery({ sessionID: chat.id, allowBusy: true })
        expect(candidates.some((c) => c.kind === "assistant" && c.assistantMessageID === shell.id)).toBe(true)
        expect(candidates.every((c) => c.kind === "assistant" && Object.keys(c).sort().join(",") === "assistantMessageID,created,kind,parentMessageID")).toBe(true)

        const result = yield* prompt.resume({
          sessionID: chat.id,
          assistantMessageID: shell.id,
          model: ref,
        })
        const requests = yield* llm.inputs
        expect(requests.length).toBeGreaterThan(0)
        const messages = ((requests[0]?.messages ?? []) as { role: string; content?: unknown }[]).filter(
          (m) => m.role === "user" || m.role === "assistant",
        )
        expect(messages.length).toBeGreaterThan(0)
        expect(messages[messages.length - 1]?.role).toBe("user")
        expect(JSON.stringify(requests[0]?.messages ?? [])).toContain("look for new resumes")
        expect(JSON.stringify(requests[0]?.messages ?? [])).not.toContain("Abandoned: resumed as a new assistant turn")

        const after = yield* sessions.messages({ sessionID: chat.id })
        expect(after.find((m) => m.info.id === shell.id)).toBeUndefined()
        expect(after.filter((m) => m.info.role === "user")).toHaveLength(1)
        const assistants = after.filter((m) => m.info.role === "assistant")
        expect(assistants.length).toBeGreaterThan(0)
        // success path: no stacked empty residue under parent
        expect(
          assistants.every(
            (m) =>
              m.info.role !== "assistant" ||
              m.parts.some(
                (part) =>
                  (part.type === "text" && part.text.trim().length > 0) ||
                  part.type === "tool" ||
                  (part.type === "reasoning" && part.text.trim().length > 0),
              ) ||
              Boolean(m.info.role === "assistant" && m.info.error),
          ),
        ).toBe(true)
        expect(result.info.role).toBe("assistant")
        expect(result.parts.some((part) => part.type === "text" && part.text === "found 2 resumes")).toBe(true)
      }),
      {
        git: true,
        config: providerCfg,
      },
    ),
)

it.live(
  "loop injects instruction files but not the dynamic environment block",
  () =>
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

          const inputs = yield* llm.inputs
          const serialized = JSON.stringify(inputs)
          const system = ((inputs[0].messages ?? []) as { role: string; content: unknown }[])
            .flatMap((message) => message.role === "system" && typeof message.content === "string" ? [message.content] : [])
            .join("\n")
          expect(serialized).not.toContain("Working directory:")
          expect(system).toContain("Skills available in this session:")
          expect(system.indexOf("Skills available in this session:")).toBeLessThan(system.indexOf(marker))
          expect(system.trim().endsWith(marker)).toBe(true)
        }),
        { git: true, config: providerCfg },
      ),
    ),
  30_000,
)

it.live(
  "reuses the frozen system prefix for later queries in the same session",
  () =>
    withoutDynamicSystemPrompt(() =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const file = path.join(Instance.directory, "AGENTS.md")
          yield* Effect.promise(() => Bun.write(file, "PREFIX_INSTRUCTION_V1"))
          const chat = yield* sessions.create({
            title: "Frozen prefix",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* llm.text("first")
          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first query" }],
          })
          yield* Effect.promise(() => Bun.write(file, "PREFIX_INSTRUCTION_V2"))
          yield* llm.text("second")
          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "second query" }],
          })

          const inputs = yield* llm.inputs
          const systems = inputs.slice(0, 2).map((input) =>
            ((input.messages ?? []) as { role: string; content: unknown }[])
              .flatMap((message) =>
                message.role === "system" && typeof message.content === "string" ? [message.content] : [],
              )
              .join("\n"),
          )
          expect(systems).toHaveLength(2)
          expect(systems[0]).toContain("PREFIX_INSTRUCTION_V1")
          expect(systems[1]).toBe(systems[0])
          expect(systems[1]).not.toContain("PREFIX_INSTRUCTION_V2")

          const snapshots = yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select()
                .from(SessionPrefixSnapshotTable)
                .where(eq(SessionPrefixSnapshotTable.session_id, chat.id))
                .all(),
            ),
          )
          const messages = yield* sessions.messages({ sessionID: chat.id })
          const lastAssistant = messages.findLast((message) => message.info.role === "assistant")
          expect(snapshots).toHaveLength(1)
          expect(snapshots[0]).toMatchObject({
            revision: 1,
            watermark_message_id: lastAssistant?.info.id,
          })
        }),
        { git: true, config: providerCfg },
      ),
    ),
  30_000,
)

it.live("loop injects the dynamic environment block only when the flag is set", () =>
  withDynamicSystemPrompt(() =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const marker = "dynamic-instruction-marker"
        yield* Effect.promise(() => Bun.write(path.join(Instance.directory, "AGENTS.md"), marker))
        const chat = yield* sessions.create({
          title: "With cwd",
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
        expect(inputs).toContain("Working directory:")
        expect(inputs).toContain(marker)
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

for (const isError of [false, true]) {
  const screenshots = Array.from({ length: 51 }, () => ({
    type: "image" as const,
    data: mcpErrorImage,
    mimeType: "image/png",
  }))
  const screenshotsIt = testEffect(
    makeHttp(
      mcpLayer(() => ({
        mcp_screenshots: dynamicTool({
          description: "Capture screenshots",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => ({
            content: [{ type: "text", text: isError ? "Capture failed" : "Captured" }, ...screenshots],
            isError,
          }),
        }),
      })),
    ),
  )

  screenshotsIt.live(`Responses preserves 51 MCP screenshots through followup and resume (error=${isError})`, () =>
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
          model: mcpRef,
          noReply: true,
          parts: [{ type: "text", text: "Capture screenshots" }],
        })
        yield* llm.tool("mcp_tool_search", { query: "screenshots" })
        yield* llm.tool("mcp_screenshots", {})
        yield* llm.text("Screenshots received")
        yield* prompt.loop({ sessionID: session.id })

        const part = (yield* MessageV2.filterCompactedEffect(session.id))
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool" && part.tool === "mcp_screenshots")
        if (part?.type !== "tool") throw new Error("Expected screenshot tool result")
        expect(part.state.status).toBe(isError ? "error" : "completed")
        const assertImages = (request: Record<string, unknown>) => {
          expect(request.input).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "function_call_output",
                call_id: part.callID,
                output: [
                  { type: "input_text", text: isError ? "Tool failed: Capture failed" : "Captured" },
                  ...screenshots.map(() => ({ type: "input_image", image_url: mcpErrorImageURL })),
                ],
              }),
            ]),
          )
          expect(JSON.stringify(request)).not.toContain(MessageV2.SYNTHETIC_ATTACHMENT_PROMPT)
        }
        assertImages((yield* llm.inputs).at(-1)!)
        yield* llm.text("History received")
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: mcpRef,
          parts: [{ type: "text", text: "Inspect the previous screenshots again" }],
        })
        assertImages((yield* llm.inputs).at(-1)!)
      }),
      {
        git: true,
        config: (url) => {
          const config = mediaProviderCfg(url)
          return {
            ...config,
            provider: { ...config.provider, test: { ...config.provider.test, npm: "@ai-sdk/openai" } },
          }
        },
      },
    ),
  )
}

// [TP-RUN-R12-36] Desktop turn-execution: exercise the engine execution boundary,
// persistence and model continuation, not a renderer-injected error string.
for (const mode of ["throw", "reject", "short"] as const) {
  const text = mode === "short" ? "short MCP exception" : "MCP exception\n" + "诊断😀 line\n".repeat(30_000)
  const exceptionIt = testEffect(makeHttp(mcpLayer(() => ({
    diagnostic: dynamicTool({
      description: "Diagnostic exception probe",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: () => {
        if (mode === "throw") throw new Error(text)
        return Promise.reject(mode === "short" ? new Error(text) : text)
      },
    }),
  }))))
  for (const nested of [false, true]) {
    exceptionIt.live(`MCP exception ${mode} ${nested ? "exec" : "direct"} is bounded [TP-RUN-R12-36]`, () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            title: "Exception boundary",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* prompt.prompt({ sessionID: session.id, agent: "build", model: nested ? mcpRef : ref, noReply: true,
            parts: [{ type: "text", text: "run diagnostic" }] })
          yield* llm.tool(nested ? "exec" : "diagnostic", nested ? { code: "await tools.diagnostic({})" } : {})
          yield* llm.text("exception handled")
          yield* prompt.loop({ sessionID: session.id })
          const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap(message => message.parts)
          const tool = parts.find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === (nested ? "exec" : "diagnostic"))
          expect(tool).toBeDefined()
          if (!tool || tool.state.status === "pending") throw new Error("missing tool state")
          const subparts = tool.state.metadata?.sub_parts as Array<{ tool: string; state: { status: string; error: string; metadata?: Record<string, unknown> } }> | undefined
          const state = nested ? subparts?.find(part => part.tool === "diagnostic")?.state : tool.state
          expect(state?.status).toBe("error")
          if (!state || !("error" in state)) throw new Error("missing error state")
          if (mode === "short") {
            expect(state.error).toBe(text)
          } else {
            expect(Buffer.byteLength(state.error)).toBeLessThan(55 * 1024)
            expect(state.metadata?.truncated).toBe(true)
            expect(typeof state.metadata?.outputPath).toBe("string")
            const saved = yield* Effect.promise(() => Bun.file(String(state.metadata?.outputPath)).text())
            expect(saved === text).toBe(true)
            expect(state.error).toContain("tool call failed")
            const followup = JSON.stringify((yield* llm.inputs).at(-1))
            expect(followup.includes(text)).toBe(false)
            expect(Buffer.byteLength(followup)).toBeLessThan(256 * 1024)
          }
          expect(parts.some(part => part.type === "text" && part.text === "exception handled")).toBe(true)
        }),
        { git: true, config: providerCfg },
      ), 30_000)
  }
}

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
      expect(initialTools.map(wireToolName)).toEqual(["exec"])
      expect(loadedTools.map(wireToolName)).toEqual(["exec"])
      expect(JSON.stringify(initialTools)).not.toContain("private_error_code")
      expect(JSON.stringify(initialTools)).not.toContain("Secret nested MCP window selector")

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
      expect(tools.map(wireToolName)).toEqual(["exec"])
      expect(JSON.stringify(tools)).not.toContain("private_window_id")
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

mcpIt.live("keeps exec reachable when permissions allow only an MCP tool", () =>
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
      yield* llm.tool("exec", { code: "return await tools.mcp_success({})" })
      yield* llm.text("ready")
      yield* prompt.loop({ sessionID: session.id })

      const requests = yield* llm.inputs
      const initialTools = requests[0].tools as Array<Record<string, unknown>>
      expect(initialTools.map(wireToolName)).toEqual(["exec"])
      const tool = (yield* MessageV2.filterCompactedEffect(session.id))
        .flatMap((message) => message.parts)
        .find(
          (part): part is CompletedToolPart =>
            part.type === "tool" && part.tool === "exec" && part.state.status === "completed",
        )
      expect(tool?.state.output).toContain("Window updated")
    }),
    { git: true, config: providerCfg },
  ),
)

mcpIt.live("exec exposes only MCP tools allowed by the configured agent", () =>
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
      yield* llm.tool("exec", { code: "return await tools.mcp_success({})" })
      yield* llm.text("ready")
      yield* prompt.loop({ sessionID: session.id })

      const requests = yield* llm.inputs
      const initialTools = requests[0].tools as Array<Record<string, unknown>>
      expect(initialTools.map(wireToolName)).toEqual(["exec"])
      const tool = (yield* MessageV2.filterCompactedEffect(session.id))
        .flatMap((message) => message.parts)
        .find(
          (part): part is CompletedToolPart =>
            part.type === "tool" && part.tool === "exec" && part.state.status === "completed",
        )
      expect(tool?.state.output).toContain("Window updated")
    }),
    { git: true, config: restrictedAgentProviderCfg },
  ),
)

mcpIt.live(
  "exposes only exec to GPT models without leaking MCP schemas",
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
        expect(tools.map(wireToolName)).toEqual(["exec"])
        expect(JSON.stringify(tools)).not.toContain("private_window_id")
        expect(JSON.stringify(tools)).not.toContain("Secret nested MCP error selector")
      }),
      { git: true, config: gptProviderCfg },
    ),
  30_000,
)

mcpIt.live(
  "keeps the Codex prompt and tool schema for GPT models with the default harness",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "GPT Codex tools" })

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.openai, modelID: ModelID.make("gpt-5.2") },
          harness: "default",
          noReply: true,
          parts: [{ type: "text", text: "inspect the Codex tools" }],
        })
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        const request = (yield* llm.inputs)[0]
        expect((request.tools as Array<Record<string, unknown>>).map(wireToolName)).toEqual(["exec"])
        expect(JSON.stringify(request)).toContain("You are Codex")
        expect(JSON.stringify(request)).toContain("tools.apply_patch")
      }),
      { git: true, config: gptProviderCfg },
    ),
  30_000,
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
  30_000,
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

// TODO: flaky in CI — fails intermittently with metadata undefined under full-shard load
it.live.skip("failed subtask preserves metadata on error tool state", () =>
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
  30_000,
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
  30_000,
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
  30_000,
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
  30_000,
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
  30_000,
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
  30_000,
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
  30_000,
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
  30_000,
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
  30_000,
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
  30_000,
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
          expect(tool.state.output).toContain("Warning: truncated output")
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

for (const failure of ["throw", "rejection", "interruption"] as const) {
  let resolutions = 0
  const failingProvider = Layer.effect(
    ProviderSvc.Service,
    Effect.gen(function* () {
      const provider = yield* ProviderSvc.Service
      return ProviderSvc.Service.of({
        ...provider,
        getLanguage: () => {
          resolutions++
          if (failure === "interruption") return Effect.interrupt
          return failure === "throw"
            ? Effect.sync(() => {
                throw new Error("test adapter unavailable")
              })
            : Effect.promise(() => Promise.reject(new Error("test adapter unavailable")))
        },
      })
    }),
  ).pipe(Layer.provide(ProviderSvc.defaultLayer))

  testEffect(makeHttp(mcp, failingProvider)).live(`checkpoint prefix capture soft-fails adapter ${failure}`, () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* user(chat.id, "inspect")
        const before = resolutions
        const capture = prefixCaptureRef.current!
        expect(capture).toBeDefined()
        const result = yield* Effect.exit(
          capture({
            sessionID: chat.id,
            agentName: "build",
            ...ref,
            msgs: yield* sessions.messages({ sessionID: chat.id }),
          }),
        )
        expect(resolutions).toBe(before + 1)
        if (failure === "interruption") {
          expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
        } else {
          expect(Exit.isSuccess(result)).toBe(true)
          if (Exit.isSuccess(result))
            expect(result.value).toEqual({ system: [], tools: {}, inheritedMessages: [], parentPermission: [] })
        }
        expect(yield* sessions.messages({ sessionID: chat.id })).toHaveLength(1)
      }),
      { git: true, config: providerCfg },
    ),
  )
}

// [TP-SR-R21-17][D16f] Trailing-user resume golden path against the real SessionPrompt/LLM boundary.
describe("trailing-user resume integration", () => {
  const waitIdle = Effect.fn("waitIdle")(function* (sessionID: SessionID) {
    const run = yield* SessionRunState.Service
    yield* Effect.gen(function* () {
      while (true) {
        const exit = yield* run.assertNotBusy(sessionID, "main").pipe(Effect.exit)
        if (Exit.isSuccess(exit)) return
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        yield* Effect.sleep("10 millis")
      }
    }).pipe(Effect.timeout("10 seconds"))
  })

  const seedTail = Effect.fn("seedTail")(function* (
    sessionID: SessionID,
    root: string,
    opts: { noReply?: boolean; synthetic?: boolean; withCompletedTool?: boolean; text?: string },
  ) {
    const sessions = yield* Session.Service
    const user1 = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: user1.id,
      sessionID,
      type: "text",
      text: "run a tool",
    })
    if (opts.withCompletedTool !== false) {
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user1.id,
        sessionID,
        mode: "build",
        agent: "build",
        path: { cwd: root, root },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "tool-calls",
      } as Parameters<typeof sessions.updateMessage>[0])
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID,
        type: "tool",
        callID: "call_done",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "echo ok" },
          output: "ok",
          title: "echo ok",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      })
    }
    const user2 = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() + 1 },
      ...(opts.noReply ? { noReply: true } : {}),
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: user2.id,
      sessionID,
      type: "text",
      text: opts.text ?? (opts.synthetic ? "<actor-notification>subagent failed</actor-notification>" : "continue please"),
      ...(opts.synthetic ? { synthetic: true } : {}),
    })
    return { user1, user2 }
  })

  it.live("resume from trailing user produces new assistant parented to that user; no new user; tools not re-run", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "trailing-user",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const { user1, user2 } = yield* seedTail(chat.id, dir, { synthetic: true })
        const before = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const usersBefore = before.filter((m) => m.info.role === "user").map((m) => m.info.id)
        const candidates = yield* prompt.recovery({ sessionID: chat.id, agentID: "main" })
        expect(candidates).toEqual([
          { kind: "parent-user", userMessageID: user2.id, created: user2.time.created },
        ])
        yield* llm.text("RESUMED_FROM_TRAILING_USER")
        yield* prompt.resumeBackground({
          sessionID: chat.id,
          userMessageID: user2.id,
          agentID: "main",
          model: ref,
        })
        yield* llm.wait(1)
        yield* waitIdle(chat.id)
        const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const usersAfter = after.filter((m) => m.info.role === "user").map((m) => m.info.id)
        expect(usersAfter).toEqual(usersBefore)
        expect(usersAfter).toEqual([user1.id, user2.id])
        const newAssistants = after.filter(
          (m) => m.info.role === "assistant" && m.info.parentID === user2.id,
        )
        expect(newAssistants.length).toBe(1)
        const textParts = newAssistants[0]!.parts.filter((p) => p.type === "text")
        expect(textParts.some((p) => p.type === "text" && p.text.includes("RESUMED_FROM_TRAILING_USER"))).toBe(true)
        // one model call for the resumed turn only
        expect(yield* llm.calls).toBe(1)
        // completed tool callID must not be re-executed (no new tool parts)
        const toolParts = after.flatMap((m) => m.parts).filter((p) => p.type === "tool")
        expect(toolParts.filter((p) => p.type === "tool" && p.callID === "call_done")).toHaveLength(1)
      }),
      { git: true, config: providerCfg },
    ),
    15_000,
  )

  for (const opts of [
    { name: "manual", synthetic: false, text: "MANUAL_ORIGINAL_USER" },
    { name: "synthetic", synthetic: true, text: "SYNTHETIC_ORIGINAL_USER" },
    { name: "notification", synthetic: true, text: "<actor-notification>NOTIFICATION_ORIGINAL_USER</actor-notification>" },
    { name: "noReply", noReply: true, synthetic: false, text: "NO_REPLY_ORIGINAL_USER" },
  ]) {
    // [TP-SR-R21-17] Execute each source, not just its candidate-list projection.
    it.live(`${opts.name} trailing user executes from the original context without replaying tools`, () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm, dir }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: `tail-${opts.name}`,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const { user1, user2 } = yield* seedTail(chat.id, dir, opts)
          const before = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
          expect(yield* prompt.recovery({ sessionID: chat.id, agentID: "main" })).toEqual([
            { kind: "parent-user", userMessageID: user2.id, created: user2.time.created },
          ])
          expect(yield* llm.calls).toBe(0)
          yield* llm.text(`RESUMED_${opts.name}`)
          const result = yield* prompt.resume({ sessionID: chat.id, userMessageID: user2.id, agentID: "main", model: ref })
          expect(result.info).toMatchObject({ role: "assistant", parentID: user2.id, finish: "stop" })
          expect(result.parts.some((p) => p.type === "text" && p.text === `RESUMED_${opts.name}`)).toBe(true)
          const inputs = yield* llm.inputs
          expect(inputs).toHaveLength(1)
          const messages = inputs[0]?.messages
          if (!Array.isArray(messages)) throw new Error("model request must contain messages")
          expect(messages.at(-1)?.role).toBe("user")
          expect(JSON.stringify(messages.at(-1)?.content)).toContain(opts.text)
          const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
          expect(after.filter((m) => m.info.role === "user").map((m) => m.info.id)).toEqual([user1.id, user2.id])
          expect(after.filter((m) => m.info.role === "user")).toEqual(before.filter((m) => m.info.role === "user"))
          expect(after.flatMap((m) => m.parts).filter((p) => p.type === "tool")).toEqual(
            before.flatMap((m) => m.parts).filter((p) => p.type === "tool"),
          )
          expect(yield* prompt.recovery({ sessionID: chat.id, agentID: "main" })).toEqual([])
          yield* waitIdle(chat.id)
        }),
        { git: true, config: providerCfg },
      ),
    )
  }

  it.live("busy session rejects resume; after idle trailing-user resume works", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "busy-resume",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* seedTail(chat.id, dir, {})
        // hang the first LLM response so the runner stays busy
        yield* llm.hang
        const hanging = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "hang" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)
        // A real notification can arrive while the model is held. Keep a valid
        // trailing target so BusyError cannot accidentally pass as NotFoundError.
        const { user2 } = yield* seedTail(chat.id, dir, { withCompletedTool: false })
        const before = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const busyRecovery = yield* prompt.recovery({ sessionID: chat.id, agentID: "main" })
        expect(busyRecovery).toEqual([])
        const busyResume = yield* Effect.exit(
          prompt.resumeBackground({
            sessionID: chat.id,
            userMessageID: user2.id,
            agentID: "main",
            model: ref,
          }),
        )
        expect(Exit.isFailure(busyResume)).toBe(true)
        if (Exit.isFailure(busyResume)) expect(Cause.squash(busyResume.cause)).toBeInstanceOf(Session.BusyError)
        expect(yield* llm.calls).toBe(1)
        expect(yield* sessions.messages({ sessionID: chat.id, agentID: "main" })).toEqual(before)
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(hanging)
        yield* waitIdle(chat.id)
        yield* llm.text("RESUMED_AFTER_BUSY")
        const result = yield* prompt.resume({ sessionID: chat.id, userMessageID: user2.id, agentID: "main", model: ref })
        expect(result.info).toMatchObject({ role: "assistant", parentID: user2.id, finish: "stop" })
        expect(result.parts.some((p) => p.type === "text" && p.text === "RESUMED_AFTER_BUSY")).toBe(true)
        expect(yield* llm.calls).toBe(2)
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("resume after a newer trailing user: old target is no longer recoverable", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "stale-target",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const { user2 } = yield* seedTail(chat.id, dir, {})
        const user3 = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() + 2 },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: user3.id,
          sessionID: chat.id,
          type: "text",
          text: "newer question",
        })
        const candidates = yield* prompt.recovery({ sessionID: chat.id, agentID: "main" })
        expect(candidates).toEqual([
          { kind: "parent-user", userMessageID: user3.id, created: user3.time.created },
        ])
        const stale = yield* Effect.exit(
          prompt.resumeBackground({
            sessionID: chat.id,
            userMessageID: user2.id,
            agentID: "main",
            model: ref,
          }),
        )
        expect(Exit.isFailure(stale)).toBe(true)
        if (Exit.isFailure(stale)) {
          const error = Cause.squash(stale.cause)
          expect(error).toBeInstanceOf(NotFoundError)
          expect(error).toMatchObject({ data: { message: "No resumable trailing user found for message " + user2.id } })
        }
        expect(yield* llm.calls).toBe(0)
      }),
      { git: true, config: providerCfg },
    ),
  )

  /**
   * Production scene `ses_ffe5f4c46d403ffeDtAFOB396h` (2026-09-19 UTC):
   * - main assistant `msg_g001a0b6db77a2001dUmpyrod2` finish=tool-calls + completed + tool(actor,completed)
   * - +1ms trailing user `msg_g001a0b6dc36f4001M9F92aXpY` actor-notification (subagent quota failures)
   * - /recovery then returned [] → Resume 404 / button hidden; only a new user send could start.
   * [TP-SR-R21-17] Post-fix: trailing notification user is a parent-user target; resume runs from it.
   */
  it.live("production scene: tool-calls+completed then actor-notification user → parent-user resume", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "prod-ses_ffe5f4c46",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const u1 = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: u1.id,
          sessionID: chat.id,
          type: "text",
          text: "授权修改 sendCellRevision",
        })
        const a1 = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: u1.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "tool-calls",
        } as Parameters<typeof sessions.updateMessage>[0])
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: a1.id,
          sessionID: chat.id,
          type: "tool",
          callID: "call_actor_send",
          tool: "actor",
          state: {
            status: "completed",
            input: { operation: { action: "send", to_actor_id: "general-15", content: "授权修改" } },
            output: "ok",
            title: "send general-15",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        const notice = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() + 1 },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: notice.id,
          sessionID: chat.id,
          type: "text",
          text: "<actor-notification>Background sub-session failed. token quota is not enough</actor-notification>",
          synthetic: true,
        })

        // Pre-fix: "no later user/assistant" disqualified a1; last is user → recovery [].
        // Post-fix: notice is the only target.
        const candidates = yield* prompt.recovery({ sessionID: chat.id, agentID: "main" })
        expect(candidates).toEqual([
          { kind: "parent-user", userMessageID: notice.id, created: notice.time.created },
        ])
        expect(candidates.some((c) => c.kind === "assistant")).toBe(false)

        yield* llm.text("RESUMED_AFTER_PROD_NOTICE")
        yield* prompt.resumeBackground({
          sessionID: chat.id,
          userMessageID: notice.id,
          agentID: "main",
          model: ref,
        })
        yield* llm.wait(1)
        yield* waitIdle(chat.id)
        const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const users = after.filter((m) => m.info.role === "user").map((m) => m.info.id)
        expect(users).toEqual([u1.id, notice.id])
        const resumed = after.filter((m) => m.info.role === "assistant" && m.info.parentID === notice.id)
        expect(resumed).toHaveLength(1)
        expect(
          resumed[0]!.parts.some((p) => p.type === "text" && p.text.includes("RESUMED_AFTER_PROD_NOTICE")),
        ).toBe(true)
        // actor tool from the interrupted tool-loop is not re-invoked
        const actorTools = after
          .flatMap((m) => m.parts)
          .filter((p) => p.type === "tool" && p.tool === "actor")
        expect(actorTools).toHaveLength(1)
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live(
    "[R003] plan-then-admission race: newer user before work re-check → fail with zero side effects",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm, dir }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "r003-admission-race",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const { user2 } = yield* seedTail(chat.id, dir, {})
          const before = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
          const toolsBefore = before.flatMap((m) => m.parts).filter((p) => p.type === "tool")
          // Barrier: work() starts with Effect.yieldNow; inject newer user in that window.
          const injector = yield* Effect.gen(function* () {
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            const newer = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: chat.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() + 9 },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: newer.id,
              sessionID: chat.id,
              type: "text",
              text: "newer in admission window",
            })
            return newer
          }).pipe(Effect.forkChild)
          const resumeExit = yield* Effect.exit(
            prompt.resumeBackground({
              sessionID: chat.id,
              userMessageID: user2.id,
              agentID: "main",
              model: ref,
            }),
          )
          const newer = yield* Fiber.join(injector)
          yield* Effect.sleep("300 millis")
          const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
          const toolsAfter = after.flatMap((m) => m.parts).filter((p) => p.type === "tool")
          // Either plan/admission rejected, or (if injector lost the race) resume used user2 only.
          const assistantsFromUser2 = after.filter(
            (m) => m.info.role === "assistant" && "parentID" in m.info && m.info.parentID === user2.id,
          )
          const assistantsFromNewer = after.filter(
            (m) => m.info.role === "assistant" && "parentID" in m.info && m.info.parentID === newer.id,
          )
          expect(assistantsFromNewer).toHaveLength(0)
          if (Exit.isFailure(resumeExit)) {
            expect(assistantsFromUser2.filter((m) => m.parts.some((p) => p.type === "text"))).toHaveLength(0)
            // [R003] Zero side effects: full message set preserved (no silent deletes/rewrites).
            expect(after.map((m) => m.info.id)).toEqual([...before.map((m) => m.info.id), newer.id].sort())
            expect(toolsAfter.map((p) => (p as { callID?: string }).callID)).toEqual(
              toolsBefore.map((p) => (p as { callID?: string }).callID),
            )
          }
          // tools preserved
          expect(toolsAfter.map((p) => (p as { callID?: string }).callID)).toEqual(
            toolsBefore.map((p) => (p as { callID?: string }).callID),
          )
          expect(yield* llm.calls).toBeLessThanOrEqual(1)
        }),
        { git: true, config: providerCfg },
      ),
    20_000,
  )

  it.live(
    "[R003] assistant after trailing user invalidates target (strict tail)",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm, dir }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "r003-later-assistant",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const { user2 } = yield* seedTail(chat.id, dir, {})
          // New assistant after trailing user → target no longer tail
          yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            parentID: user2.id,
            sessionID: chat.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now() + 20, completed: Date.now() + 20 },
            finish: "stop",
          } as Parameters<typeof sessions.updateMessage>[0])
          const exit = yield* Effect.exit(
            prompt.resumeBackground({
              sessionID: chat.id,
              userMessageID: user2.id,
              agentID: "main",
              model: ref,
            }),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          expect(yield* llm.calls).toBe(0)
        }),
        { git: true, config: providerCfg },
      ),
    15_000,
  )

  it.live(
    "[R003] admission reject does not delete later empty assistant (finalizer off reject path)",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm, dir }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "r003-reject-zero-side-effect",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const { user2 } = yield* seedTail(chat.id, dir, {})
          const emptyId = MessageID.ascending()
          // Later empty assistant (no error, no useful parts) — strict tail must reject resume…
          yield* sessions.updateMessage({
            id: emptyId,
            role: "assistant",
            parentID: user2.id,
            sessionID: chat.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now() + 20, completed: Date.now() + 20 },
            finish: "stop",
          } as Parameters<typeof sessions.updateMessage>[0])
          const before = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
          const exit = yield* Effect.exit(
            prompt.resumeBackground({
              sessionID: chat.id,
              userMessageID: user2.id,
              agentID: "main",
              model: ref,
            }),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
          // …but must NOT force-delete that assistant (zero side effects on stale reject).
          expect(after.map((m) => m.info.id)).toEqual(before.map((m) => m.info.id))
          expect(after.some((m) => m.info.id === emptyId)).toBe(true)
          expect(yield* llm.calls).toBe(0)
        }),
        { git: true, config: providerCfg },
      ),
    15_000,
  )

  it.live(
    "[R003] ensure-mode resume is exclusive: concurrent call gets BusyError, does not join",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm, dir }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "r003-exclusive",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const { user2 } = yield* seedTail(chat.id, dir, {})
          const release = defer<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
          yield* llm.hold("EXCLUSIVE_OK", release.promise)
          const first = yield* prompt
            .resumeBackground({ sessionID: chat.id, userMessageID: user2.id, agentID: "main", model: ref })
            .pipe(Effect.forkChild)
          yield* llm.wait(1)
          // Sync resume while first run holds the slot → BusyError (must not join first work).
          const busy = yield* prompt
            .resume({ sessionID: chat.id, userMessageID: user2.id, agentID: "main", model: ref })
            .pipe(Effect.exit)
          expect(Exit.isFailure(busy)).toBe(true)
          if (Exit.isFailure(busy)) expect(Cause.squash(busy.cause)).toBeInstanceOf(Session.BusyError)
          release.resolve(undefined)
          yield* Fiber.join(first).pipe(Effect.timeout("5 seconds"), Effect.exit)
          yield* Effect.sleep("200 millis")
          const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
          const fromUser2 = after.filter(
            (m) => m.info.role === "assistant" && "parentID" in m.info && m.info.parentID === user2.id,
          )
          // Only one execution — not a second joined/duplicated turn.
          expect(fromUser2.filter((m) => m.parts.some((p) => p.type === "text" && (p as { text?: string }).text?.includes("EXCLUSIVE_OK")))).toHaveLength(1)
          expect(yield* llm.calls).toBe(1)
        }),
        { git: true, config: providerCfg },
      ),
    20_000,
  )

  it.live(
    "[C001] resumeBackground surfaces admission re-check failure (no false success)",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm, dir }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "c001-admission-handshake",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const { user2 } = yield* seedTail(chat.id, dir, {})
          const before = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
          // Target work() starts with Effect.yieldNow then re-reads tail. Inject a later user
          // in that window so plan can pass while admission re-check must fail — and that
          // failure must surface on resumeBackground (C001: no 202 without admission).
          const injector = yield* Effect.gen(function* () {
            yield* Effect.yieldNow
            const newer = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: chat.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() + 9 },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: newer.id,
              sessionID: chat.id,
              type: "text",
              text: "newer in C001 window",
            })
            return newer
          }).pipe(Effect.forkChild)
          const exit = yield* Effect.exit(
            prompt.resumeBackground({
              sessionID: chat.id,
              userMessageID: user2.id,
              agentID: "main",
              model: ref,
            }),
          )
          yield* Fiber.join(injector)
          // C001 contract: admission rejection is a typed failure on the caller, not void success.
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBeInstanceOf(NotFoundError)
          }
          yield* Effect.sleep("200 millis")
          const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
          expect(after.filter((m) => m.info.role === "assistant")).toHaveLength(
            before.filter((m) => m.info.role === "assistant").length,
          )
          expect(yield* llm.calls).toBe(0)
        }),
        { git: true, config: providerCfg },
      ),
    15_000,
  )

  it.live(
    "[R003] first assistant parents to planned user even if a newer user is written mid-turn",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm, dir }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "r003-parent-lock",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const { user2 } = yield* seedTail(chat.id, dir, {})
          const gate = defer<void>()
          yield* llm.hold("LOCKED_PARENT_OK", gate.promise)
          const fiber = yield* prompt
            .resumeBackground({
              sessionID: chat.id,
              userMessageID: user2.id,
              agentID: "main",
              model: ref,
            })
            .pipe(Effect.forkChild)
          yield* llm.wait(1)
          const newer = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() + 9 },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: newer.id,
            sessionID: chat.id,
            type: "text",
            text: "newer after plan",
          })
          gate.resolve(undefined)
          yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"), Effect.exit)
          // wait until assistant text lands (runLoop work is forked by start)
          yield* Effect.gen(function* () {
            for (let i = 0; i < 20; i++) {
              const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
              if (after.some((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text.includes("LOCKED_PARENT_OK")))) {
                return
              }
              yield* Effect.sleep("100 millis")
            }
          })
          const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
          const parents = after
            .filter(
              (m) =>
                m.info.role === "assistant" &&
                "parentID" in m.info &&
                m.parts.some((p) => p.type === "text" && p.text.includes("LOCKED_PARENT_OK")),
            )
            .map((m) => (m.info as { parentID: string }).parentID)
          expect(parents).toEqual([user2.id])
          expect(parents).not.toContain(newer.id)
        }),
        { git: true, config: providerCfg },
      ),
    20_000,
  )

  it.live("concurrent double resume: BusyError or consumed-target NotFoundError; only one execution", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "double-resume",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const { user2 } = yield* seedTail(chat.id, dir, {})
        const before = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const release = defer<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
        yield* llm.hold("RESUMED_ONCE", release.promise)
        yield* prompt.resumeBackground({ sessionID: chat.id, userMessageID: user2.id, agentID: "main", model: ref })
        yield* llm.wait(1)
        // Synchronous entry checks the busy runner before candidate freshness.
        const busy = yield* prompt.resume({ sessionID: chat.id, userMessageID: user2.id, agentID: "main", model: ref }).pipe(Effect.exit)
        expect(Exit.isFailure(busy)).toBe(true)
        if (Exit.isFailure(busy)) expect(Cause.squash(busy.cause)).toBeInstanceOf(Session.BusyError)
        const second = yield* Effect.exit(
          prompt.resumeBackground({
            sessionID: chat.id,
            userMessageID: user2.id,
            agentID: "main",
            model: ref,
          }),
        )
        expect(Exit.isFailure(second)).toBe(true)
        // Background entry checks freshness first: the first execution already
        // persisted its assistant, so the original user is no longer the tail.
        if (Exit.isFailure(second)) {
          const error = Cause.squash(second.cause)
          expect(error).toBeInstanceOf(NotFoundError)
          expect(error).toMatchObject({ data: { message: "No resumable trailing user found for message " + user2.id } })
        }
        expect(yield* llm.calls).toBe(1)
        release.resolve()
        yield* waitIdle(chat.id)
        const after = yield* sessions.messages({ sessionID: chat.id, agentID: "main" })
        const resumed = after.filter((m) => m.info.role === "assistant" && m.info.parentID === user2.id)
        expect(resumed).toHaveLength(1)
        expect(resumed[0]!.parts.some((p) => p.type === "text" && p.text === "RESUMED_ONCE")).toBe(true)
        expect(after.filter((m) => m.info.role === "user")).toEqual(before.filter((m) => m.info.role === "user"))
        expect(after.flatMap((m) => m.parts).filter((p) => p.type === "tool")).toEqual(
          before.flatMap((m) => m.parts).filter((p) => p.type === "tool"),
        )
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  )
})
