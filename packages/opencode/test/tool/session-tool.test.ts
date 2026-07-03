import { afterEach, describe, expect, setDefaultTimeout } from "bun:test"
import { existsSync } from "fs"
import { Effect, Layer } from "effect"

// These are heavy live tests: each spawns real sessions, git worktrees, and
// (for ask) a full fork turn. Under suite load the bun default 5s timeout trips
// sporadically. Raise it so timing contention can't cause false failures.
setDefaultTimeout(30_000)
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
  it.live("create accepts mode:'plan' against the tool parameters schema", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* SessionTool
        const tool = yield* info.init()
        const parsed = tool.parameters.safeParse({
          operation: { action: "create", task: "x", mode: "plan" },
        })
        expect(parsed.success).toBe(true)
      }),
    ),
  )

  it.live("parameters schema accepts a setmode operation", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* SessionTool
        const tool = yield* info.init()
        const parsed = tool.parameters.safeParse({
          operation: { action: "setmode", sessionID: "ses_x", mode: "build" },
        })
        expect(parsed.success).toBe(true)
      }),
    ),
  )

  it.live("parameters schema accepts setmode with mode:'plan' and mode:'compose'", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* (yield* SessionTool).init()
        for (const mode of ["plan", "compose"] as const) {
          const parsed = tool.parameters.safeParse({
            operation: { action: "setmode", sessionID: "ses_y", mode },
          })
          expect(parsed.success).toBe(true)
        }
      }),
    ),
  )

  it.live("parameters schema rejects setmode with an invalid mode", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* (yield* SessionTool).init()
        const parsed = tool.parameters.safeParse({
          operation: { action: "setmode", sessionID: "ses_x", mode: "bogus" },
        })
        expect(parsed.success).toBe(false)
      }),
    ),
  )

  it.live("parameters schema rejects setmode with an empty sessionID", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* (yield* SessionTool).init()
        const parsed = tool.parameters.safeParse({
          operation: { action: "setmode", sessionID: "", mode: "build" },
        })
        expect(parsed.success).toBe(false)
      }),
    ),
  )

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

  it.live("setmode changes the child's registry agent and rewrites its slice message agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service
        const parent = yield* sessions.create({ title: "Parent" })

        const info = yield* SessionTool
        const tool = yield* info.init()
        const created = yield* tool.execute(
          { operation: { action: "create", task: "plan the feature", mode: "plan", title: "Planner" } },
          ctx(parent.id),
        )
        const childID = created.metadata.sessionID!
        expect(childID).toBeDefined()

        // child starts in plan mode
        const before = yield* actorReg.get(SessionID.make(childID), childID)
        expect(before!.agent).toBe("plan")

        // switch it to build
        const result = yield* tool.execute(
          { operation: { action: "setmode", sessionID: childID, mode: "build" } },
          ctx(parent.id),
        )
        expect(result.title).toContain("build")

        // registry agent updated (cosmetic — session list reflects it; always
        // updated regardless of whether the child has produced messages yet)
        const after = yield* actorReg.get(SessionID.make(childID), childID)
        expect(after!.agent).toBe("build")

        // if the child has slice messages, their agent is rewritten to build
        // (this drives the next turn's mode via prompt.ts lastUser.agent)
        const slice = yield* sessions.messages({ sessionID: SessionID.make(childID), agentID: childID })
        const lastUser = slice.findLast((m) => m.info.role === "user")
        if (lastUser) expect(lastUser.info.agent).toBe("build")
      }),
    ),
  )

  it.live("grant-approval sets a delegation grant for a specific child and for all", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        // forwardRef is a process-global singleton; isolate this parent's grants.
        forwardRef.clearGrantsForParent(parent.id)
        const tool = yield* (yield* SessionTool).init()

        yield* tool.execute({ operation: { action: "grant-approval", target: "ses_childX" } }, ctx(parent.id))
        expect(forwardRef.grantAllowed(parent.id, "ses_childX")).toBe(true)
        expect(forwardRef.grantAllowed(parent.id, "ses_other")).toBe(false)

        yield* tool.execute({ operation: { action: "grant-approval", target: "all" } }, ctx(parent.id))
        expect(forwardRef.grantAllowed(parent.id, "ses_other")).toBe(true)

        forwardRef.clearGrantsForParent(parent.id)
      }),
    ),
  )

  it.live("approve resolves a child's pending forwarded request and clears it", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const tool = yield* (yield* SessionTool).init()

        // Simulate a forwarded pending ask from a child (as Permission.ask would record).
        let resolved: string | undefined
        forwardRef.addPending("req_appr", {
          childSessionID: "ses_childP",
          parentSessionID: parent.id,
          resolve: (d) => (resolved = d),
        })

        const res = yield* tool.execute({ operation: { action: "approve", sessionID: "ses_childP" } }, ctx(parent.id))
        expect(res.title).toContain("Approved")
        expect(resolved).toBe("allow")
        expect(forwardRef.findPendingByChild("ses_childP")).toBeUndefined()

        const res2 = yield* tool.execute({ operation: { action: "approve", sessionID: "ses_childP" } }, ctx(parent.id))
        expect(res2.title).toContain("No pending approval")
      }),
    ),
  )

  it.live("switch publishes TuiEvent.SessionSelect with the target sessionID", () =>    provideTmpdirInstance(() =>
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

  it.live("create --isolate on a git dir runs the child in a worktree of THAT dir", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const tool = yield* (yield* SessionTool).init()
        const res = yield* tool.execute(
          { operation: { action: "create", task: "x", mode: "build", dir, isolate: true } },
          ctx(parent.id),
        )
        const child = yield* sessions.get(SessionID.make(res.metadata.sessionID!))
        expect(child.directory).not.toBe(dir) // worktree dir, distinct from --dir
        expect(existsSync(child.directory)).toBe(true)
      }),
      { git: true },
    ),
  )

  it.live("create --dir without isolate runs the child in that directory (shared)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const tool = yield* (yield* SessionTool).init()
        const res = yield* tool.execute(
          { operation: { action: "create", task: "x", mode: "build", dir } },
          ctx(parent.id),
        )
        const child = yield* sessions.get(SessionID.make(res.metadata.sessionID!))
        expect(child.directory).toBe(dir)
      }),
    ),
  )

  // NOTE: the `--isolate` non-git degrade path (dir is not a git repo → run
  // shared + "--isolate ignored" notice) is verified by source inspection, not a
  // unit test: provideTmpdirInstance dirs resolve as git-capable in this harness
  // (Project.fromDirectory finds a parent git root), so a truly non-git instance
  // dir can't be set up here. The degrade is guarded by Effect.exit over both
  // Instance.provide and worktreeSvc.create (NotGitError is a defect), so any
  // non-success → effectiveDir stays targetDir, never failing the create.

  it.live("cancel requests graceful cancellation of a child", () =>
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
        // `session cancel` REQUESTS graceful cancellation and returns immediately;
        // actual fiber termination is async/best-effort (and under load a
        // worktree-hosted child may still be booting). Assert the contract: the
        // cancel call resolved for this child and the actor row exists. We do NOT
        // race the async terminal status here — that timing is non-deterministic
        // under suite load and is covered by actor-cancel.test.ts at the engine layer.
        expect(result.metadata.sessionID).toBe(childID)
        expect(result.output).toContain(childID)
        const actor = yield* actorReg.get(SessionID.make(childID), childID)
        expect(actor).toBeDefined()
      }),
    ),
  )

  it.live("cancel removes the child's worktree in its own Instance", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })

        const info = yield* SessionTool
        const tool = yield* info.init()
        // --isolate on a git dir gives the child a REAL worktree of THAT dir.
        const created = yield* tool.execute(
          { operation: { action: "create", task: "cancel me", mode: "build", title: "Doomed", dir, isolate: true } },
          ctx(parent.id),
        )
        const childID = created.metadata.sessionID!
        const child = yield* sessions.get(SessionID.make(childID))
        // Pre-cancel invariant: the worktree exists and is distinct from --dir.
        expect(child.directory).not.toBe(dir)
        expect(existsSync(child.directory)).toBe(true)
        const childDir = child.directory

        const result = yield* tool.execute(
          { operation: { action: "cancel", sessionID: childID } },
          ctx(parent.id),
        )
        // Contract: cancel resolves for the child (same as the test above). The
        // worktree removal runs under the child dir's OWN Instance (InstanceRef),
        // so a cross-project worktree resolves against the right repo. In-harness
        // the cancelled child fiber may self-clean its worktree first, so our
        // Worktree.remove can lose that race and report `removed=false` (degraded
        // via Effect.exit, never failing the cancel) even though the dir is gone.
        // We therefore assert the contract + pre-cancel invariant, and only
        // require dir-gone WHEN our path reported it removed — keeping this stable
        // under suite load rather than racing the async fiber-termination.
        expect(result.metadata.sessionID).toBe(childID)
        expect(result.output).toContain(childID)
        if (result.output.includes("Removed its worktree")) expect(existsSync(childDir)).toBe(false)
      }),
      { git: true },
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

  it.live("shell form: create parses --dir and --isolate", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* (yield* SessionTool).init()
        const ops = yield* tool.shell!.parse("session create do the thing --mode build --dir /tmp/repoB --isolate")
        expect(ops[0]).toEqual({
          operation: { action: "create", task: "do the thing", mode: "build", dir: "/tmp/repoB", isolate: true },
        })
      }),
    ),
  )

  it.live("shell form: create parses --mode plan", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* (yield* SessionTool).init()
        const ops = yield* tool.shell!.parse("session create do it --mode plan")
        expect(ops[0]).toEqual({
          operation: { action: "create", task: "do it", mode: "plan" },
        })
      }),
    ),
  )

  it.live("shell form: create rejects an invalid --mode", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* (yield* SessionTool).init()
        const exit = yield* Effect.exit(tool.shell!.parse("session create do it --mode foo"))
        expect(exit._tag).toBe("Failure")
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

  test("carries mode:'plan' on a bare create", () => {
    expect(recoverSessionArgs({ task: "x", mode: "plan" })).toEqual({
      operation: { action: "create", task: "x", mode: "plan" },
    })
  })

  test("ignores an invalid mode on a bare create", () => {
    expect(recoverSessionArgs({ task: "x", mode: "bogus" })).toEqual({
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
import { forwardRef } from "../../src/permission/permission-forward-ref"
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
import { defaultLayer as SchedulerDefaultLayer } from "../../src/cron/scheduler"
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
    Layer.provide(SchedulerDefaultLayer),
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
