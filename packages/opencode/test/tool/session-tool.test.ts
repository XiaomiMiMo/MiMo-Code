import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { Agent } from "../../src/agent/agent"
import { Actor } from "../../src/actor/spawn"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { Session } from "../../src/session"
import { Worktree } from "../../src/worktree"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID } from "../../src/provider/schema"
import { TaskRegistry } from "../../src/task/registry"
import { Truncate } from "../../src/tool"
import { SessionTool } from "../../src/tool/session"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

// The session tool resolves Session / ActorRegistry / Provider as Layer deps and
// the Actor service via the late-bound spawnRef (populated by Actor.defaultLayer).
// `create` now goes through Actor.spawn({ mode: "peer" }), which itself creates
// the child session, registers the peer, and background-forks the first turn.
const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    ActorRegistry.defaultLayer,
    Provider.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Bus.defaultLayer,
    // session tool's create/cancel use Worktree.Service (worktree-per-child).
    Worktree.defaultLayer,
    // Actor.defaultLayer populates spawnRef.current, which the session tool's
    // create/cancel branches read via requireActor(). Without it they fail fast.
    Actor.defaultLayer,
  ),
)

const ctx = (sessionID: string) => ({
  sessionID: SessionID.make(sessionID),
  messageID: MessageID.ascending(),
  agent: "build",
  actorID: "main",
  abort: new AbortController().signal,
  extra: {},
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("session tool", () => {
  it.live("create spawns a child peer session registered with mode peer + agent build", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service
        const parent = yield* sessions.create({ title: "Parent" })

        const info = yield* SessionTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          {
            operation: {
              action: "create",
              task: "build a login page",
              mode: "build",
              title: "Login",
            },
          },
          ctx(parent.id),
        )

        // The tool returns the child session id.
        const childID = result.metadata.sessionID
        expect(childID).toBeDefined()
        expect(result.output).toContain(childID!)

        // The child session persists independently with parent linkage.
        const child = yield* sessions.get(SessionID.make(childID!))
        expect(child.parentID).toBe(parent.id)

        // The child is registered as a peer in the actor registry.
        const actor = yield* actorReg.get(SessionID.make(childID!), childID!)
        expect(actor).toBeDefined()
        expect(actor!.mode).toBe("peer")
        expect(actor!.agent).toBe("build")
      }),
    ),
  )

  it.live("switch publishes TuiEvent.SessionSelect with the target sessionID", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const target = yield* sessions.create({ title: "Target" })

        // The tool publishes via the module-level Bus.publish (the production
        // path the TUI route uses — tui.ts:379), NOT the instance Bus.Service.
        // Subscribe through the matching module-level Bus.subscribe.
        const seen: string[] = []
        const unsub = Bus.subscribe(TuiEvent.SessionSelect, (event) => seen.push(event.properties.sessionID))

        const info = yield* SessionTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: { action: "switch", sessionID: target.id } },
          ctx(parent.id),
        )

        unsub()
        expect(seen).toEqual([target.id])
        expect(result.metadata.sessionID).toBe(target.id)
        expect(result.output).toContain(target.id)
      }),
    ),
  )

  it.live("list returns each child session id, title, agent and status", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })

        const info = yield* SessionTool
        const tool = yield* info.init()

        const a = yield* tool.execute(
          { operation: { action: "create", task: "task A", mode: "build", title: "Alpha" } },
          ctx(parent.id),
        )
        const b = yield* tool.execute(
          { operation: { action: "create", task: "task B", mode: "compose", title: "Beta" } },
          ctx(parent.id),
        )
        const idA = a.metadata.sessionID!
        const idB = b.metadata.sessionID!

        const result = yield* tool.execute({ operation: { action: "list" } }, ctx(parent.id))

        expect(result.title).toBe("Child sessions: 2")
        expect(result.output).toContain(idA)
        expect(result.output).toContain(idB)
        // create overwrites spawnPeer's default `${agentType}: ${task}` title
        // with the explicit --title, so the listing shows Alpha/Beta.
        expect(result.output).toContain("Alpha")
        expect(result.output).toContain("Beta")
        // agent (the NL "mode") is surfaced from the actor row.
        expect(result.output).toContain("build")
        expect(result.output).toContain("compose")
      }),
    ),
  )

  it.live("list returns an empty message when there are no children", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Lonely" })
        const info = yield* SessionTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ operation: { action: "list" } }, ctx(parent.id))
        expect(result.title).toBe("Child sessions: 0")
        expect(result.output).toBe("No child sessions.")
      }),
    ),
  )

  it.live("cancel stops a child and the registry reflects a cancelled outcome", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service
        const parent = yield* sessions.create({ title: "Parent" })

        const info = yield* SessionTool
        const tool = yield* info.init()
        const created = yield* tool.execute(
          { operation: { action: "create", task: "cancel me", mode: "build", title: "Doomed" } },
          ctx(parent.id),
        )
        const childID = created.metadata.sessionID!

        const result = yield* tool.execute(
          { operation: { action: "cancel", sessionID: childID } },
          ctx(parent.id),
        )
        expect(result.metadata.sessionID).toBe(childID)
        expect(result.output).toContain(childID)

        // cancel asks Actor.cancel to interrupt the child and mark it idle. The
        // child's first turn (under the test LLM) can finish before cancel lands,
        // so the terminal outcome is either "cancelled" (interrupted in time) or
        // "success" (already done) — both leave the row idle. Poll for idle, then
        // assert the outcome is one of the two terminal values.
        const settled = yield* Effect.gen(function* () {
          const a = yield* actorReg.get(SessionID.make(childID), childID)
          if (a?.status === "idle") return a
          return yield* Effect.fail("not settled")
        }).pipe(Effect.retry({ times: 50, schedule: Schedule.spaced("50 millis") }))
        expect(settled!.status).toBe("idle")
        expect(["cancelled", "success"]).toContain(settled!.lastOutcome ?? "")
      }),
    ),
  )
})

// End-to-end proof that BOTH invocation schemas drive the tool identically:
// the shell form (shell.parse → execute) and the JSON form (execute on a
// structured operation) each create a real peer child session.
describe("session tool dual-schema (shell + JSON) end-to-end", () => {
  it.live("shell form: parse('session create ...') then execute creates a peer child", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service
        const parent = yield* sessions.create({ title: "Parent" })

        const info = yield* SessionTool
        const tool = yield* info.init()

        // Drive the SHELL schema: a raw script string through shell.parse.
        const ops = yield* tool.shell!.parse("session create build a login page --mode compose --title Login")
        expect(ops).toHaveLength(1)
        expect(ops[0]).toEqual({
          operation: { action: "create", task: "build a login page", mode: "compose", title: "Login" },
        })

        // Feed the parsed op to execute — the same entry the JSON form uses.
        const result = yield* tool.execute(ops[0], ctx(parent.id))
        const childID = result.metadata.sessionID
        expect(childID).toBeDefined()

        const child = yield* sessions.get(SessionID.make(childID!))
        expect(child.parentID).toBe(parent.id)
        const actor = yield* actorReg.get(SessionID.make(childID!), childID!)
        expect(actor!.mode).toBe("peer")
        expect(actor!.agent).toBe("compose")
      }),
    ),
  )

  it.live("JSON form: execute on a structured operation creates a peer child", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service
        const parent = yield* sessions.create({ title: "Parent" })

        const info = yield* SessionTool
        const tool = yield* info.init()

        // Drive the JSON schema: a structured operation object straight to execute.
        const result = yield* tool.execute(
          { operation: { action: "create", task: "write tests", mode: "build" } },
          ctx(parent.id),
        )
        const childID = result.metadata.sessionID
        expect(childID).toBeDefined()

        const child = yield* sessions.get(SessionID.make(childID!))
        expect(child.parentID).toBe(parent.id)
        const actor = yield* actorReg.get(SessionID.make(childID!), childID!)
        expect(actor!.mode).toBe("peer")
        expect(actor!.agent).toBe("build")
      }),
    ),
  )

  it.live("shell form: parses every verb (create/list/switch/cancel)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* SessionTool
        const tool = yield* info.init()
        const parse = (s: string) => tool.shell!.parse(s)

        expect(yield* parse("session list")).toEqual([{ operation: { action: "list" } }])
        expect(yield* parse("session switch ses_abc")).toEqual([
          { operation: { action: "switch", sessionID: "ses_abc" } },
        ])
        expect(yield* parse("session cancel ses_xyz")).toEqual([
          { operation: { action: "cancel", sessionID: "ses_xyz" } },
        ])
      }),
    ),
  )

  it.live("shell form: parses 'ask' into session_id + joined question", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* SessionTool
        const tool = yield* info.init()
        const parse = (s: string) => tool.shell!.parse(s)

        expect(yield* parse("session ask ses_x what is your progress")).toEqual([
          { operation: { action: "ask", session_id: "ses_x", question: "what is your progress" } },
        ])
        // A single-word question still parses (>= 2 positionals required).
        expect(yield* parse("session ask ses_y summarize")).toEqual([
          { operation: { action: "ask", session_id: "ses_y", question: "summarize" } },
        ])
      }),
    ),
  )

  it.live("ask on a session with no history returns a graceful no-activity answer (no spawn)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const target = yield* sessions.create({ title: "Empty" })

        const info = yield* SessionTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: { action: "ask", session_id: target.id, question: "what is your progress?" } },
          ctx(target.id),
        )

        expect(result.title).toBe(`Asked ${target.id}`)
        expect(result.metadata.sessionID).toBe(target.id)
        expect(result.output).toContain("no activity yet")
        // No child session was spawned to answer an empty target.
        const children = yield* sessions.children(target.id)
        expect(children).toHaveLength(0)
      }),
    ),
  )
})

import { test } from "bun:test"
import { recoverSessionArgs } from "../../src/tool/session"

describe("recoverSessionArgs", () => {
  test("salvages a bare {task} into a create operation", () => {
    expect(recoverSessionArgs({ task: "build a login page" })).toEqual({
      operation: { action: "create", task: "build a login page" },
    })
  })

  test("carries mode/model/title on a bare create", () => {
    expect(recoverSessionArgs({ task: "x", mode: "compose", model: "standard", title: "T" })).toEqual({
      operation: { action: "create", task: "x", mode: "compose", model: "standard", title: "T" },
    })
  })

  test("parses a stringified operation", () => {
    expect(recoverSessionArgs({ operation: '{"action":"list"}' })).toEqual({ operation: { action: "list" } })
  })

  test("passes through an already-nested operation", () => {
    expect(recoverSessionArgs({ operation: { action: "switch", sessionID: "ses_x" } })).toEqual({
      operation: { action: "switch", sessionID: "ses_x" },
    })
  })

  test("returns undefined for unrecoverable input", () => {
    expect(recoverSessionArgs({ foo: "bar" })).toBeUndefined()
    expect(recoverSessionArgs(null)).toBeUndefined()
    expect(recoverSessionArgs("nope")).toBeUndefined()
  })

  test("ignores an invalid mode on a bare create", () => {
    expect(recoverSessionArgs({ task: "x", mode: "plan" })).toEqual({
      operation: { action: "create", task: "x" },
    })
  })
})

// ---------------------------------------------------------------------------
// Functional `ask` (fork-query) end-to-end. Needs the FULL session-prompt stack
// + a real (test) LLM so the spawned read-only fork can run a turn over the
// frozen snapshot and return an answer. This harness mirrors fork-agent-compat:
// SessionPrompt.layer populates prefixCaptureRef (the captor forkQuery uses),
// and Actor.layer populates spawnRef (the actor the session tool spawns through).
// ---------------------------------------------------------------------------
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Config } from "../../src/config"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider"
import { Env } from "../../src/env"
import { ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
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
import { ActorWaiter } from "../../src/actor/waiter"
import { Memory } from "../../src/memory"
import { History } from "../../src/history"
import { Team } from "../../src/team"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { SessionCompaction } from "../../src/session/compaction"
import { Auth } from "../../src/auth"
import { MessageV2 } from "../../src/session/message-v2"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirServer } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { Inbox } from "../../src/inbox"

const askSummary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const askMcp = Layer.succeed(
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
    startAuth: () => Effect.die("unexpected MCP auth in ask test"),
    authenticate: () => Effect.die("unexpected MCP auth in ask test"),
    finishAuth: () => Effect.die("unexpected MCP auth in ask test"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const askLsp = Layer.succeed(
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

function makeAskLayer() {
  const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
  const runState = SessionRunState.layer.pipe(Layer.provide(status))
  const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
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
    askLsp,
    askMcp,
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
  const proc = SessionProcessor.layer.pipe(Layer.provide(askSummary), Layer.provideMerge(deps))
  const prune = SessionPrune.layer.pipe(Layer.provide(checkpoint), Layer.provideMerge(deps))
  const prompt = SessionPrompt.layer.pipe(
    Layer.provide(Goal.defaultLayer),
    Layer.provide(TaskGateState.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(askSummary),
    Layer.provide(checkpoint),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(team),
    Layer.provide(taskRegistry),
    Layer.provideMerge(runState),
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
  // Surface the services the SessionTool's init needs (Session/ActorRegistry/
  // Provider/Worktree = Deps, plus Truncate + Agent) alongside Actor so the test
  // body can yield* SessionTool. provideMerge keeps them in the output context.
  return Layer.mergeAll(
    TestLLMServer.layer,
    inbox,
    Actor.layer.pipe(
      Layer.provideMerge(prompt),
      Layer.provideMerge(Worktree.defaultLayer),
      Layer.provideMerge(taskRegistry),
      Layer.provide(TaskRegistry.defaultLayer),
      Layer.provide(Inbox.defaultLayer),
    ),
    trunc,
  ).pipe(Layer.provideMerge(deps), Layer.provide(askSummary))
}

const askIt = testEffect(makeAskLayer())

const askProviderCfg = (url: string) => ({
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
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

describe("session tool ask (fork-query) functional", () => {
  askIt.live("ask spawns a READ-ONLY fork over a target with history and returns its answer", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service

        // A target session with real main-slice history (a user message —
        // required for buildPrefix not to bail to the empty path).
        const target = yield* sessions.create({
          title: "Target with history",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user" as const,
          sessionID: target.id,
          agentID: "main",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        } as unknown as MessageV2.Info)

        // The fork's single turn answers from the frozen snapshot.
        yield* llm.text("The session is setting up a login page.")

        const info = yield* SessionTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: { action: "ask", session_id: target.id, question: "what is this session doing?" } },
          ctx(target.id),
        )

        // Non-empty answer, returned to the caller; not the empty-history path.
        expect(result.title).toBe(`Asked ${target.id}`)
        expect(result.output.length).toBeGreaterThan(0)
        expect(result.output).not.toContain("no activity yet")

        // The fork ran in its own child session parented to the target (frozen
        // snapshot host), so the target's own main slice is untouched.
        const children = yield* sessions.children(target.id)
        expect(children.length).toBe(1)

        // READ-ONLY enforcement: the spawned fork actor's tool whitelist is
        // exactly read/grep/glob — no write/edit/bash/patch. prompt.ts rejects
        // any tool outside this list, so the fork CANNOT mutate state.
        // READ-ONLY enforcement: the spawned fork actor's tool whitelist is
        // exactly read/grep/glob — no write/edit/bash/patch. prompt.ts rejects
        // any tool outside this list, so the fork CANNOT mutate state. (The
        // child session also carries an auto-registered "main" row; the fork is
        // the subagent row.)
        const forkActor = (yield* actorReg.listBySession(children[0].id)).find((a) => a.mode === "subagent")
        expect(forkActor).toBeDefined()
        const forkTools = forkActor!.tools
        expect(forkTools).toEqual(["read", "grep", "glob"])
        for (const banned of ["write", "edit", "bash", "apply_patch", "notebook_edit"]) {
          expect(forkTools).not.toContain(banned)
        }
      }),
      { git: true, config: askProviderCfg },
    ),
    60000,
  )
})
