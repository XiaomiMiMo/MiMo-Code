/**
 * Fork-agent inbox compat test — Plan 4 / Task 5
 *
 * Key invariant (from docs/superpowers/specs/2026-05-26-fork-agent-prefix-cache-design.md):
 *   When a fork agent (contextMode="full") receives an inbox message, the
 *   `inheritedMessages` snapshot captured at spawn time must NOT be invalidated.
 *   Drain writes only to the fork's own agentID slice (beyond the watermark);
 *   the inherited prefix is untouched.
 *
 * Acceptance tier: structural (tier 2) + slice-routing (tier 3).
 *   - Tier 2: getForkContext() before and after drain — inheritedMessages identical.
 *   - Tier 3: drained synthetic message lands in fork's slice, NOT main's slice.
 */

import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, describe, expect } from "bun:test"
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
import { Auth } from "../../src/auth"
import { MessageID, PartID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
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
    startAuth: () => Effect.die("unexpected MCP auth in fork-agent-compat test"),
    authenticate: () => Effect.die("unexpected MCP auth in fork-agent-compat test"),
    finishAuth: () => Effect.die("unexpected MCP auth in fork-agent-compat test"),
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
  const inbox = Inbox.defaultLayer.pipe(Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    inbox,
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

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function providerCfg(url: string) {
  return {
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
          baseURL: url,
        },
      },
    },
  }
}

describe("Fork-agent inbox compat (Plan 4 / Task 5)", () => {
  it.live("tier 2+3: inheritedMessages snapshot unchanged after inbox drain, synthetic msg in fork slice only", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const inbox = yield* Inbox.Service
        const reg = yield* ActorRegistry.Service

        const parent = yield* session.create({
          title: "fork-agent compat test",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // Seed two synthetic "inherited" messages in the forkContext — these
        // represent the parent's conversation history that a fork agent would
        // inherit at spawn time.
        const inheritedMessages: MessageV2.Info[] = [
          {
            id: MessageID.ascending(),
            sessionID: parent.id,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info,
          {
            id: MessageID.ascending(),
            sessionID: parent.id,
            role: "assistant" as const,
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info,
        ]

        const watermarkID = MessageID.ascending()

        const fakeForkCtx: Actor.ForkContext = {
          system: ["inherited-system-prompt"],
          tools: {},
          inheritedMessages: inheritedMessages as unknown as import("ai").ModelMessage[],
          parentPermission: [],
          watermarkMsgID: watermarkID,
          model: ref,
        }

        // Hang the LLM — fork agent runs in background, we only need the registry
        // entry and forkContexts map to be populated, not the actual LLM call.
        yield* llm.hang

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "explore",
          task: "fork-agent compat test task",
          context: "full",
          tools: [],
          background: true,
          model: ref,
          forkContext: fakeForkCtx,
        })

        const forkActorID = result.actorID

        // Tier 2 — structural: capture forkContext BEFORE inbox send.
        const forkCtxBefore = yield* actor.getForkContext(forkActorID)
        expect(forkCtxBefore).toBeDefined()
        expect(forkCtxBefore?.system).toEqual(["inherited-system-prompt"])
        expect(forkCtxBefore?.inheritedMessages).toHaveLength(2)

        // Seed a real message in the fork's slice so drain's lastReal predicate
        // can resolve. Drain requires a prior real assistant/user turn in the
        // fork's agentID slice before it will write the synthetic user message.
        yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID: parent.id,
          agentID: forkActorID,
          time: { created: Date.now() },
          agent: "explore",
          model: ref,
        } as unknown as MessageV2.Info)
        // Seed a matching assistant turn so the "model" field is available to drain.
        yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant" as const,
          sessionID: parent.id,
          agentID: forkActorID,
          time: { created: Date.now() },
          agent: "explore",
          model: ref,
        } as unknown as MessageV2.Info)

        // Send an inbox message to the fork actor.
        yield* inbox.send({
          receiverSessionID: parent.id,
          receiverActorID: forkActorID,
          content: "inbox-message-for-fork",
        })

        // Tier 3 — slice routing: drain it manually.
        const drained = yield* inbox.drain(parent.id, forkActorID)
        expect(drained).toBe(1)

        // Tier 2 — structural: forkContext must still have the exact same
        // inheritedMessages snapshot. Drain must not touch forkContexts.
        const forkCtxAfter = yield* actor.getForkContext(forkActorID)
        expect(forkCtxAfter).toBeDefined()
        expect(forkCtxAfter?.inheritedMessages).toStrictEqual(forkCtxBefore?.inheritedMessages)
        expect(forkCtxAfter?.system).toEqual(["inherited-system-prompt"])

        // Tier 3 — slice routing: the synthetic user message must appear in the
        // fork's own slice (agentID = forkActorID), not in main's slice.
        const forkMsgs = yield* session.messages({ sessionID: parent.id, agentID: forkActorID })
        const mainMsgs = yield* session.messages({ sessionID: parent.id, agentID: "main" })

        const forkSynthetic = forkMsgs.filter((m) => m.parts.some((p) => p.type === "text" && p.synthetic))
        const mainSynthetic = mainMsgs.filter((m) => m.parts.some((p) => p.type === "text" && p.synthetic))

        // Fork slice must contain the synthetic message with inbox content.
        expect(forkSynthetic.length).toBeGreaterThan(0)
        const syntheticText = forkSynthetic
          .flatMap((m) => m.parts)
          .filter((p): p is Extract<MessageV2.Part, { type: "text" }> => p.type === "text" && (p as any).synthetic)
          .map((p) => p.text)
          .join("")
        expect(syntheticText).toContain("inbox-message-for-fork")

        // Main slice must NOT contain any synthetic parts (drain never wrote there).
        expect(mainSynthetic.length).toBe(0)

        // Cleanup: cancel the hanging fork fiber.
        yield* actor.cancel(parent.id, forkActorID, "forced")
      }),
      { git: true, config: providerCfg },
    ),
  )
})
