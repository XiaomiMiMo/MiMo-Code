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
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { Inbox } from "../../src/inbox"
import { progressPath } from "../../src/session/checkpoint-paths"

// This file is a focused REPRO, not a permanent regression guard. It exists to
// answer one question empirically: when a subagent's actor.postStop hook
// (subagent-progress-checker) demands a tasks/<TID>/progress.md, does the agent's
// own permission ruleset decide whether the file can ever be written?
//
//   - `general` has permission defaults ("*":"allow") → write/edit survive
//     Permission.disabled → the postStop "use the Write tool" nudge is satisfiable
//     → progress.md lands.
//   - `explore` has "*":"deny" (read-only) → write/edit are stripped from its
//     LLM-visible tool set by Permission.disabled → the same nudge references a
//     tool it cannot call → no file unless it falls back to bash.
//
// We assert the permission-layer fact directly (deterministic, model-free) AND
// drive the general path end-to-end with a scripted LLM that writes the file.

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
    startAuth: () => Effect.die("unexpected MCP auth in repro"),
    authenticate: () => Effect.die("unexpected MCP auth in repro"),
    finishAuth: () => Effect.die("unexpected MCP auth in repro"),
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
    AgentSvc.defaultLayer,
    Actor.layer.pipe(
      Layer.provideMerge(prompt),
      Layer.provideMerge(taskRegistry),
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
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, baseURL: url } },
    },
  }
}

const FIVE_SECTION_BODY = [
  "## §1 Task identity",
  "- task_id: T1",
  "- short summary: probe",
  "",
  "## §2 Subagent intent",
  "Confirm general can write its own progress journal.",
  "",
  "## §3 Files and code sections",
  "- readme.txt: read it",
  "",
  "## §4 Verbatim commands",
  "```",
  "(none)",
  "```",
  "",
  "## §5 Outcome and discoveries",
  "- Outcome (success): wrote progress.md via Write tool",
].join("\n")

describe("postStop progress.md is gated by the subagent's write permission", () => {
  // PERMISSION-LAYER FACT (deterministic, no LLM): the exact predicate that
  // decides whether the postStop "use the Write tool" nudge can ever succeed.
  // agents.get reads config, which needs an Instance context — so run it inside
  // provideTmpdirServer like the end-to-end case.
  it.live("explore disables write/edit; general keeps them", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const agents = yield* AgentSvc.Service
        const explore = yield* agents.get("explore")
        const general = yield* agents.get("general")

        const toolIds = ["read", "write", "edit", "bash"]
        const exploreDisabled = Permission.disabled(toolIds, explore.permission)
        const generalDisabled = Permission.disabled(toolIds, general.permission)

        // explore ("*":deny) strips write+edit → postStop nudge is unsatisfiable.
        expect(exploreDisabled.has("write")).toBe(true)
        expect(exploreDisabled.has("edit")).toBe(true)
        expect(exploreDisabled.has("read")).toBe(false) // read explicitly allowed
        expect(exploreDisabled.has("bash")).toBe(false) // bash explicitly allowed (fallback path)

        // general ("*":allow) keeps write+edit → nudge is satisfiable.
        expect(generalDisabled.has("write")).toBe(false)
        expect(generalDisabled.has("edit")).toBe(false)
      }),
      { git: true, config: providerCfg },
    ),
  )

  // END-TO-END (scripted LLM): a task-bound `general` that returns WITHOUT writing
  // progress.md is re-prompted by postStop; on the next turn it calls Write to the
  // canonical progress path; the file lands on disk with all 5 required sections.
  // Session permission is left DEFAULT (no "*":allow override) so the agent's OWN
  // ruleset is what governs — general's defaults ("*":allow) keep write enabled.
  it.live("general bound to task_id writes progress.md when postStop re-prompts", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const tasks = yield* TaskRegistry.Service

        const parent = yield* session.create({ title: "general progress repro" })
        const task = yield* tasks.create({ session_id: parent.id, summary: "probe" })

        const target = progressPath(parent.id, task.id)

        // Turn 1 (spawn): finish WITHOUT writing the journal → postStop sees the
        // file missing and re-prompts with output.continue=true.
        yield* llm.text("**Status**: success\n**Summary**: did the work (forgot the journal)")
        // Turn 2 (postStop re-entry): obey the nudge — write the 5-section file.
        yield* llm.tool("write", { file_path: target, content: FIVE_SECTION_BODY })
        // Turn 2 still needs a terminal assistant message after the tool result.
        yield* llm.text("**Status**: success\n**Summary**: wrote progress.md")
        // Slack for any additional postStop iterations.
        yield* llm.text("**Status**: success\n**Summary**: done")
        yield* llm.text("**Status**: success\n**Summary**: done")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "general",
          task: "do the work",
          context: "none",
          tools: "INHERIT",
          background: false,
          model: ref,
          task_id: task.id,
        })
        expect(result.actorID).toBe("general-1")

        yield* Deferred.await(result.outcome).pipe(Effect.timeout("30 seconds"))

        const fs = yield* AppFileSystem.Service
        const exists = yield* fs.existsSafe(target)
        expect(exists).toBe(true)
        const body = yield* fs.readFileString(target)
        for (const section of [
          "## §1 Task identity",
          "## §2 Subagent intent",
          "## §3 Files and code sections",
          "## §4 Verbatim commands",
          "## §5 Outcome and discoveries",
        ]) {
          expect(body).toContain(section)
        }
      }),
      { git: true, config: providerCfg },
    ),
  )

  // CONTRAST (scripted LLM): the SAME path with `explore` (read-only). explore's "*":deny
  // makes canWrite=false (computed in forkWork from agentInfo.permission), so the postStop
  // progress checker SKIPS — no nudge, no wasted re-entry turns — and no progress.md lands.
  // explore's findings are delivered to the caller via finalText, which is the read-only
  // contract. (Contrast: the `general` case above, where canWrite=true and the file lands.)
  it.live("explore bound to task_id skips the progress check (no journal, clean finish)", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const actor = yield* Actor.Service
        const session = yield* Session.Service
        const tasks = yield* TaskRegistry.Service

        const parent = yield* session.create({ title: "explore progress skip" })
        const task = yield* tasks.create({ session_id: parent.id, summary: "probe" })
        const target = progressPath(parent.id, task.id)

        // Single turn: explore delivers findings as finalText. postStop must NOT re-prompt
        // (canWrite=false → checker skips), so one terminal turn is all that's consumed.
        // Extra slack turns are provided but should go unused.
        yield* llm.text("**Status**: success\n**Summary**: explored, findings in body")
        yield* llm.text("**Status**: success\n**Summary**: (unused)")
        yield* llm.text("**Status**: success\n**Summary**: (unused)")

        const result = yield* actor.spawn({
          mode: "subagent",
          sessionID: parent.id,
          agentType: "explore",
          task: "look around",
          context: "none",
          tools: "INHERIT",
          background: false,
          model: ref,
          task_id: task.id,
        })
        expect(result.actorID).toBe("explore-1")

        const outcome = yield* Deferred.await(result.outcome).pipe(Effect.timeout("30 seconds"))
        // Spawn completes cleanly (not stuck on an impossible write nudge).
        expect(outcome.status).toBe("success")

        // Zero wasted re-entries: a skipped read-only agent consumes exactly ONE LLM turn
        // (the single delivery turn). The old re-prompt loop would have consumed more.
        // The 2 extra scripted slack turns above must go unused.
        const turns = yield* llm.calls
        expect(turns).toBe(1)

        const fs = yield* AppFileSystem.Service
        const exists = yield* fs.existsSafe(target)
        // No journal: read-only explore is not asked to maintain task progress.
        expect(exists).toBe(false)
      }),
      { git: true, config: providerCfg },
    ),
  )
})
