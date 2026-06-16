/**
 * Integration test for text loop detection using MockLLM (no HTTP server).
 *
 * Run:
 *   cd packages/opencode && bun test test/session/text-loop-integration.test.ts
 */
import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect } from "bun:test"
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
import { SessionCompaction } from "../../src/session/compaction"
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
import { Memory } from "../../src/memory"
import { History } from "../../src/history"
import { Team } from "../../src/team"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { TaskRegistry } from "../../src/task/registry"
import { TaskGateState } from "../../src/task/gate-state"
import { Auth } from "../../src/auth"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { FetchHttpClient } from "effect/unstable/http"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MockLLM, textReply, textWithToolReply } from "../lib/mock-llm"
import { Inbox } from "../../src/inbox"

void Log.init({ print: true })

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
    startAuth: () => Effect.die("unexpected"),
    authenticate: () => Effect.die("unexpected"),
    finishAuth: () => Effect.die("unexpected"),
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

// Shared mock — accessible from test body to enqueue replies
const mockLLM = new MockLLM()

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

function makeLayers() {
  const taskRegistry = ActorRegistry.defaultLayer
  const llmLayer = mockLLM.layer()
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    llmLayer,
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
    Layer.provide(taskRegistry),
  )
  const taskWaiter = ActorWaiter.layer.pipe(Layer.provide(Bus.layer), Layer.provide(taskRegistry))
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
  return SessionPrompt.layer.pipe(
    Layer.provide(Goal.defaultLayer),
    Layer.provide(TaskGateState.defaultLayer),
    Layer.provide(TaskRegistry.defaultLayer),
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
  )
}

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
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(makeLayers())

describe("text loop detection (integration, MockLLM)", () => {
  it.live("detects 3 identical texts and injects recovery prompt", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service

          const session = yield* sessions.create({
            title: "Text loop test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "create a changelog" }],
          })

          // Enqueue 3 identical text+tool replies (triggers detection)
          // then 1 different text reply (after recovery)
          mockLLM.enqueue(
            textWithToolReply("Let me check if one was already created.", "check", { q: 1 }),
            textWithToolReply("Let me check if one was already created.", "check", { q: 1 }),
            textWithToolReply("Let me check if one was already created.", "check", { q: 1 }),
            textReply("I will try a different approach now."),
          )

          const result = yield* prompt.loop({ sessionID: session.id })

          // === DUMP TRAJECTORY TO FILE ===
          mockLLM.dumpTrajectory("/tmp/text-loop-trajectory.json")
          console.log(`[text-loop] Trajectory dumped to /tmp/text-loop-trajectory.json`)

          // === FULL TRAJECTORY DUMP ===
          const allMsgs = yield* sessions.messages({ sessionID: session.id })
          console.log("\n========== FULL TRAJECTORY ==========")
          console.log(`Total messages: ${allMsgs.length}`)
          console.log(`MockLLM calls: ${mockLLM.calls}`)
          console.log("")
          for (const msg of allMsgs) {
            const role = msg.info.role
            const agent = "agent" in msg.info ? (msg.info as any).agent : ""
            const finish = "finish" in msg.info ? (msg.info as any).finish : ""
            console.log(`--- [${role}] agent=${agent} finish=${finish} id=${msg.info.id} ---`)
            for (const part of msg.parts) {
              if (part.type === "text") {
                const synthetic = "synthetic" in part && part.synthetic ? " (synthetic)" : ""
                const preview = part.text.length > 80 ? part.text.slice(0, 80) + "..." : part.text
                console.log(`  TEXT${synthetic}: ${preview}`)
              } else if (part.type === "tool") {
                const state = (part as any).state
                console.log(`  TOOL: ${(part as any).tool} | status=${state?.status} | input=${JSON.stringify(state?.input)}`)
              } else if (part.type === "reasoning") {
                const preview = part.text.length > 60 ? part.text.slice(0, 60) + "..." : part.text
                console.log(`  REASONING: ${preview}`)
              } else {
                console.log(`  ${part.type.toUpperCase()}`)
              }
            }
          }
          console.log("========== END TRAJECTORY ==========\n")

          console.log(`[text-loop] MockLLM calls: ${mockLLM.calls}`)
          expect(mockLLM.calls).toBe(4)

          // Final message should contain the recovered text
          expect(result.parts.some((p) => p.type === "text" && p.text.includes("different approach"))).toBe(true)

          // Verify recovery prompt was injected as a separate user message
          const msgs = yield* sessions.messages({ sessionID: session.id })
          const recoveryMsg = msgs.find(
            (m) => m.info.role === "user" && m.parts.some(
              (p) => p.type === "text" && "synthetic" in p && p.synthetic && p.text.includes("LOOP DETECTED"),
            ),
          )
          console.log(`[text-loop] Recovery prompt injected as new message: ${!!recoveryMsg}`)
          expect(recoveryMsg).toBeDefined()
          // It should NOT be on the original user message
          const originalUser = msgs.find(
            (m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "create a changelog"),
          )
          const hasRecoveryOnOriginal = originalUser?.parts.some(
            (p) => p.type === "text" && p.text.includes("LOOP DETECTED"),
          )
          expect(hasRecoveryOnOriginal).toBeFalsy()
        }),
      { git: true, config: cfg },
    ),
    30_000,
  )

  it.live("detects loop even when reasoning differs but text is identical", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service

          const session = yield* sessions.create({
            title: "Reasoning varies test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "create a changelog" }],
          })

          // 3 replies: DIFFERENT reasoning, SAME text → should still trigger
          mockLLM.reset()
          mockLLM.enqueue(
            textWithToolReply("Let me check the file.", "check", { q: 1 }, "Thinking about approach A..."),
            textWithToolReply("Let me check the file.", "check", { q: 1 }, "Maybe I should try approach B instead..."),
            textWithToolReply("Let me check the file.", "check", { q: 1 }, "Let me reconsider approach C..."),
            textReply("OK I found a different way."),
          )

          const result = yield* prompt.loop({ sessionID: session.id })

          console.log(`[reasoning-test] MockLLM calls: ${mockLLM.calls}`)
          expect(mockLLM.calls).toBe(4) // 3 repeated + 1 after recovery
          expect(result.parts.some((p) => p.type === "text" && p.text.includes("different way"))).toBe(true)
        }),
      { git: true, config: cfg },
    ),
    30_000,
  )

  it.live("7 repeated messages: triggers recovery twice then continues", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service

          const session = yield* sessions.create({
            title: "7 repeats test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "help me fix a bug" }],
          })

          // 7 identical replies + 1 final different reply
          // Flow: 3→trigger#1(mild), 3→trigger#2(strong), 1 more then final stop
          mockLLM.reset()
          const repeated = textWithToolReply(
            "The user wants me to create a ChangeLog file separately. Let me check if one was already created earlier and update it with all the changes we've made.",
            "glob",
            { pattern: "CHANGELOG*" },
            "Thinking about how to approach this...",
          )
          for (let i = 0; i < 7; i++) {
            mockLLM.enqueue(repeated)
          }
          mockLLM.enqueue(textReply("I apologize for the confusion. Let me take a completely different approach."))

          const result = yield* prompt.loop({ sessionID: session.id })

          // Dump trajectory
          mockLLM.dumpTrajectory("/tmp/text-loop-7-repeats.json")
          console.log(`\n[7-repeats] Trajectory: /tmp/text-loop-7-repeats.json`)
          console.log(`[7-repeats] MockLLM calls: ${mockLLM.calls}`)

          // Print message summary
          const allMsgs = yield* sessions.messages({ sessionID: session.id })
          console.log(`[7-repeats] Total messages: ${allMsgs.length}`)
          console.log("")
          for (const msg of allMsgs) {
            const role = msg.info.role
            const finish = "finish" in msg.info ? (msg.info as any).finish : ""
            const syntheticParts = msg.parts.filter((p) => "synthetic" in p && (p as any).synthetic)
            const textParts = msg.parts.filter((p) => p.type === "text" && !("synthetic" in p && (p as any).synthetic))
            const text = textParts.map((p) => p.type === "text" ? p.text : "").join("").slice(0, 60)
            const synthetic = syntheticParts.map((p) => p.type === "text" ? p.text.slice(0, 40) : "").join("")
            if (synthetic) {
              console.log(`  [${role}] (synthetic) ${synthetic}...`)
            } else {
              console.log(`  [${role}] finish=${finish} | "${text}${text.length >= 60 ? "..." : ""}"`)
            }
          }
          console.log("")

          // Verify: 2 recovery prompts injected (mild + strong)
          const recoveryMsgs = allMsgs.filter(
            (m) => m.info.role === "user" && m.parts.some((p) => "synthetic" in p && (p as any).synthetic && p.type === "text" && p.text.includes("system-reminder")),
          )
          console.log(`[7-repeats] Recovery messages injected: ${recoveryMsgs.length}`)
          expect(recoveryMsgs.length).toBe(2)
          expect(recoveryMsgs[0].parts.some((p) => p.type === "text" && p.text.includes("LOOP DETECTED"))).toBe(true)
          expect(recoveryMsgs[1].parts.some((p) => p.type === "text" && p.text.includes("CRITICAL"))).toBe(true)
        }),
      { git: true, config: cfg },
    ),
    30_000,
  )
})
