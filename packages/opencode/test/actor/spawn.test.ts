import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { and, eq } from "drizzle-orm"
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
import { Auth } from "../../src/auth"
import { Database } from "../../src/storage"
import { MessageTable } from "../../src/session/session.sql"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { reply } from "../lib/llm-server"
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

describe("Actor.spawn peer mode", () => {
  it.live("creates a new sessionID, registers actor with mode=peer", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const reg = yield* ActorRegistry.Service

        const parent = yield* session.create({
          title: "test parent",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // Queue a stop response so the prompt loop can run to completion.
        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "peer",
          sessionID: parent.id,
          agentType: "build",
          task: "test task",
          context: "none",
          tools: ["read"],
          background: true,
          model: ref,
        })

        expect(result.actorID).not.toBe(parent.id)
        expect(result.sessionID as string).toBe(result.actorID)

        const row = yield* reg.get(result.sessionID, result.actorID)
        expect(row?.mode).toBe("peer")
        expect(row?.agent).toBe("build")
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.spawn subagent mode", () => {
  it.live("does NOT create new session, allocates <type>-<n> actorID", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const reg = yield* ActorRegistry.Service

        const parent = yield* session.create({
          title: "test parent",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "checkpoint task",
          context: "full",
          tools: ["read", "edit"],
          background: true,
          model: ref,
        })

        expect(result.sessionID).toBe(parent.id)
        expect(result.actorID).toBe("build-1")

        const row = yield* reg.get(parent.id, result.actorID)
        expect(row?.mode).toBe("subagent")
        expect(row?.agent).toBe("build")
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.spawn fiber lifecycle", () => {
  it.live("outcome resolves with success when fiber completes normally", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "x",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")
        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "minimal task",
          context: "none",
          tools: ["read"],
          background: false, // blocking — wait for completion
          model: ref,
        })
        const outcome = yield* Deferred.await(result.outcome)
        expect(["success", "failure"]).toContain(outcome.status)
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.cancel", () => {
  it.live("cancel(forced) interrupts fiber and marks actor cancelled", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const reg = yield* ActorRegistry.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "x",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        // Hang the LLM so the fiber stays alive long enough to interrupt.
        yield* llm.hang
        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "long task",
          context: "none",
          tools: ["read"],
          background: true,
          model: ref,
        })
        yield* actor.cancel(result.sessionID, result.actorID, "forced")
        const row = yield* reg.get(result.sessionID, result.actorID)
        expect(row?.status).toBe("idle")
        expect(row?.lastOutcome).toBe("cancelled")
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.spawn agent_id persistence", () => {
  it.live("subagent's user message is persisted with agent_id = actorID", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "agent_id verification",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "agent_id verification task",
          context: "none",
          tools: ["read"],
          background: false,
          model: ref,
        })

        // Wait for the agent loop to complete.
        yield* Deferred.await(result.outcome)

        // Query the message table directly: the user message persisted by
        // SessionPrompt.prompt should carry agent_id = actorID.
        expect(result.actorID).toBe("build-1")

        const rows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select({ id: MessageTable.id, agent_id: MessageTable.agent_id })
              .from(MessageTable)
              .where(and(eq(MessageTable.session_id, parent.id), eq(MessageTable.agent_id, result.actorID)))
              .all(),
          ),
        )

        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
          expect(row.agent_id).toBe(result.actorID)
        }
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.spawn context_watermark", () => {
  it.live("subagent with context=full captures latest main message ID as watermark", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const reg = yield* ActorRegistry.Service

        const parent = yield* session.create({
          title: "watermark verification",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // Seed parent main thread with a few user messages (agent_id IS NULL).
        const seeded: MessageID[] = []
        for (const text of ["main-1", "main-2", "main-3"]) {
          const id = MessageID.ascending()
          yield* session.updateMessage({
            id,
            sessionID: parent.id,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)
          yield* session.updatePart({
            id: PartID.ascending(),
            sessionID: parent.id,
            messageID: id,
            type: "text",
            text,
          })
          seeded.push(id)
        }

        // Sanity-check Session.lastMainMessageID returns the latest seeded ID.
        const last = yield* session.lastMainMessageID(parent.id)
        expect(last).toBe(seeded[seeded.length - 1])

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "watermark check",
          context: "full",
          tools: ["read"],
          background: true,
          model: ref,
        })

        const row = yield* reg.get(parent.id, result.actorID)
        expect(row?.contextWatermark).toBeDefined()
        expect(row?.contextWatermark).toBe(seeded[seeded.length - 1])
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.spawn description field (F2a)", () => {
  it.live("falls back to agentType when description not provided", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const reg = yield* ActorRegistry.Service

        const parent = yield* session.create({
          title: "fallback parent",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "x".repeat(500),  // long, would be sliced to 200 chars under the bug
          context: "none",
          tools: ["read"],
          background: true,
          model: ref,
        })

        const row = yield* reg.get(result.sessionID, result.actorID)
        expect(row?.description).toBe("build")  // agentType, NOT first 200 chars of task
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("uses provided description when supplied", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const reg = yield* ActorRegistry.Service

        const parent = yield* session.create({
          title: "explicit parent",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "long prompt body",
          description: "explore: find lexer files",
          context: "none",
          tools: ["read"],
          background: true,
          model: ref,
        })

        const row = yield* reg.get(result.sessionID, result.actorID)
        expect(row?.description).toBe("explore: find lexer files")
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor forkContext lifecycle", () => {
  it.live("forkContext is cleared after actor is cancelled (cancel path)", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service

        const parent = yield* session.create({
          title: "forkCtx lifecycle",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // Hang the LLM so the fiber stays alive while we verify pre-cancel state.
        yield* llm.hang

        const fakeForkCtx = {
          system: ["test-system"],
          tools: {},
          inheritedMessages: [],
          parentPermission: [],
          watermarkMsgID: MessageID.ascending(),
          model: ref,
        }

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "explore",
          task: "noop",
          context: "none",
          tools: [],
          background: true,
          model: ref,
          forkContext: fakeForkCtx,
        })

        // Before cancel: forkContext must be present.
        const before = yield* actor.getForkContext(result.actorID)
        expect(before).toBeDefined()
        expect(before?.system).toEqual(["test-system"])

        // Cancel forces immediate termination.
        yield* actor.cancel(result.sessionID, result.actorID, "forced")

        // After cancel: forkContext must be gone.
        const after = yield* actor.getForkContext(result.actorID)
        expect(after).toBeUndefined()
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("mode × contextMode matrix", () => {
  const fakeForkCtx: Actor.ForkContext = {
    system: ["test-system"],
    tools: {},
    inheritedMessages: [],
    parentPermission: [],
    watermarkMsgID: MessageID.make("msg_test_watermark"),
    model: { providerID: ProviderID.make("test") as ProviderID, modelID: ModelID.make("test") as ModelID },
  }

  it.live("subagent + full: forkContext stored under actorID", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service

        const parent = yield* session.create({
          title: "matrix subagent+full",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.hang

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "explore",
          task: "noop",
          context: "full",
          tools: [],
          background: true,
          model: ref,
          forkContext: fakeForkCtx,
        })

        const ctx = yield* actor.getForkContext(result.actorID)
        expect(ctx).toBeDefined()
        expect(ctx?.system).toEqual(["test-system"])

        yield* actor.cancel(result.sessionID, result.actorID, "forced")
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("subagent + none: no forkContext stored", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service

        const parent = yield* session.create({
          title: "matrix subagent+none",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.hang

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "explore",
          task: "noop",
          context: "none",
          tools: [],
          background: true,
          model: ref,
          // no forkContext
        })

        const ctx = yield* actor.getForkContext(result.actorID)
        expect(ctx).toBeUndefined()

        yield* actor.cancel(result.sessionID, result.actorID, "forced")
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("peer + full: forkContext stored under child session id (result.actorID)", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service

        const parent = yield* session.create({
          title: "matrix peer+full",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.hang

        const result = yield* actor.spawn({
          mode: "peer",
          sessionID: parent.id,
          agentType: "explore",
          task: "noop",
          context: "full",
          tools: [],
          background: true,
          model: ref,
          forkContext: fakeForkCtx,
        })

        // For peer, result.actorID === child.id (the new session id)
        expect(result.actorID).not.toBe(parent.id)
        const ctx = yield* actor.getForkContext(result.actorID)
        expect(ctx).toBeDefined()
        expect(ctx?.system).toEqual(["test-system"])

        yield* actor.cancel(result.sessionID, result.actorID, "forced")
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("peer + none: no forkContext stored", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service

        const parent = yield* session.create({
          title: "matrix peer+none",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.hang

        const result = yield* actor.spawn({
          mode: "peer",
          sessionID: parent.id,
          agentType: "explore",
          task: "noop",
          context: "none",
          tools: [],
          background: true,
          model: ref,
          // no forkContext
        })

        const ctx = yield* actor.getForkContext(result.actorID)
        expect(ctx).toBeUndefined()

        yield* actor.cancel(result.sessionID, result.actorID, "forced")
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.spawn structured output (P3)", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean" }, count: { type: "number" } },
    required: ["ok", "count"],
  }

  it.live("format=json_schema → outcome.structured carries the validated object, finalText dropped", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "structured success",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // Fake model emits a preamble text part AND calls StructuredOutput in the
        // SAME turn. Per §5.2 precedence, structured must win and finalText (the
        // preamble) must be dropped. (Must be one turn: a text-only turn under
        // json_schema would trip StructuredOutputError before a second turn runs.)
        yield* llm.push(reply().text("Here is my analysis…").tool("StructuredOutput", { ok: true, count: 3 }))

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "return structured",
          context: "none",
          tools: ["read"],
          background: false,
          model: ref,
          format: { type: "json_schema", schema, retryCount: 2 },
        })

        const outcome = yield* Deferred.await(result.outcome)
        expect(outcome.status).toBe("success")
        if (outcome.status === "success") {
          expect(outcome.structured).toEqual({ ok: true, count: 3 })
          // §5.2: structured present → finalText dropped (no preamble duplication)
          expect(outcome.finalText).toBeUndefined()
        }
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("no format → outcome.finalText only, structured undefined", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "plain text",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.text("plain answer")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "return text",
          context: "none",
          tools: ["read"],
          background: false,
          model: ref,
        })

        const outcome = yield* Deferred.await(result.outcome)
        expect(outcome.status).toBe("success")
        if (outcome.status === "success") {
          expect(outcome.structured).toBeUndefined()
          expect(outcome.finalText).toContain("plain answer")
        }
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.spawn onActorID pre-registration (MR104 #2)", () => {
  // The workflow runtime needs the child's actorID in its reclaim set BEFORE the
  // background work fiber detaches, otherwise a cancel that races an in-flight
  // spawn leaves an orphan. spawn exposes onActorID: fired synchronously inside
  // the spawn Effect, right after register(), before forkWork detaches. Proof:
  // by the time spawn RESOLVES to the caller, the callback has already run AND
  // carries the SAME actorID the registry was populated with — so any consumer
  // (the workflow) is guaranteed to know the id the instant the actor exists.
  it.live("onActorID fires with the registered actorID before spawn resolves", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const reg = yield* ActorRegistry.Service

        const parent = yield* session.create({
          title: "onActorID timing",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        // Hang so the background fiber is alive — the callback must fire on the
        // SPAWN path (synchronously, pre-detach), not when the work completes.
        yield* llm.hang

        const seen: string[] = []
        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "build",
          task: "long task",
          context: "none",
          tools: ["read"],
          background: true,
          model: ref,
          onActorID: (id) => seen.push(id),
        })

        // Resolved → callback ALREADY ran exactly once, with the resolved actorID.
        expect(seen).toEqual([result.actorID])
        // And the registry row for that id exists (register ran before the cb).
        const row = yield* reg.get(parent.id, result.actorID)
        expect(row?.actorID).toBe(result.actorID)

        yield* actor.cancel(result.sessionID, result.actorID, "forced")
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.spawn concurrent same-session result isolation", () => {
  it.live("two concurrent subagents in one session return their own results", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service

        const parent = yield* session.create({
          title: "concurrent",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // Bind distinct LLM responses to each subagent by matching on the task
        // text in the request body. Each subagent's request carries ONLY its own
        // task (agent-scoped message slice), so the substring match is unambiguous.
        yield* llm.textMatch((h) => JSON.stringify(h.body).includes("task ALPHA"), "RESULT_ALPHA")
        yield* llm.textMatch((h) => JSON.stringify(h.body).includes("task BETA"), "RESULT_BETA")

        const [a, b] = yield* Effect.all(
          [
            actor.spawn({
              mode: "subagent",
              sessionID: parent.id,
              agentType: "build",
              task: "task ALPHA",
              context: "none",
              tools: ["read"],
              background: true,
              model: ref,
            }),
            actor.spawn({
              mode: "subagent",
              sessionID: parent.id,
              agentType: "build",
              task: "task BETA",
              context: "none",
              tools: ["read"],
              background: true,
              model: ref,
            }),
          ],
          { concurrency: "unbounded" },
        )

        const oa = yield* Deferred.await(a.outcome)
        const ob = yield* Deferred.await(b.outcome)
        const ra = oa.status === "success" ? oa.finalText : undefined
        const rb = ob.status === "success" ? ob.finalText : undefined

        // a is ALPHA, b is BETA — each must carry its OWN result. Pre-fix, the
        // session-wide lastAssistant lookup collapses both onto whichever actor
        // persisted last, so ra === rb (both BETA, the newest ascending ID).
        expect(ra).toBe("RESULT_ALPHA")
        expect(rb).toBe("RESULT_BETA")
      }),
      { git: true, config: providerCfg },
    ),
  )
})

describe("Actor.spawn return-format injection (F21)", () => {
  it.live("non-specialized subagent (general) gets return-format instruction injected", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service

        const parent = yield* session.create({
          title: "F21 inject test",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "general",
          task: "do this thing",
          context: "none",
          tools: ["read"],
          background: false,
          model: ref,
        })

        yield* Deferred.await(result.outcome)

        const msgs = yield* session.messages({ sessionID: result.sessionID })
        const subAgentUser = msgs.find((m) => m.info.role === "user" && m.info.agentID === result.actorID)
        expect(subAgentUser).toBeDefined()
        const text = subAgentUser?.parts.find((p) => p.type === "text")?.text ?? ""
        expect(text).toContain("Return format (required)")
        expect(text).toContain("**Status**:")
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("explore subagent does NOT get return-format injection", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service

        const parent = yield* session.create({
          title: "F21 explore exclusion",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "explore",
          task: "search for foo",
          context: "none",
          tools: ["read", "grep", "glob"],
          background: false,
          model: ref,
        })

        yield* Deferred.await(result.outcome)

        const msgs = yield* session.messages({ sessionID: result.sessionID })
        const subAgentUser = msgs.find((m) => m.info.role === "user" && m.info.agentID === result.actorID)
        const text = subAgentUser?.parts.find((p) => p.type === "text")?.text ?? ""
        expect(text).not.toContain("Return format (required)")
      }),
      { git: true, config: providerCfg },
    ),
  )

  it.live("checkpoint-writer subagent does NOT get return-format injection", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service

        const parent = yield* session.create({
          title: "F21 writer exclusion",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.text("done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "checkpoint-writer",
          task: "write the next checkpoint for this session",
          context: "full",
          tools: ["read", "write", "edit", "glob", "grep"],
          background: false,
          model: ref,
        })

        yield* Deferred.await(result.outcome)

        const msgs = yield* session.messages({ sessionID: result.sessionID })
        const subAgentUser = msgs.find((m) => m.info.role === "user" && m.info.agentID === result.actorID)
        const text = subAgentUser?.parts.find((p) => p.type === "text")?.text ?? ""
        expect(text).not.toContain("Return format (required)")
      }),
      { git: true, config: providerCfg },
    ),
  )
})
