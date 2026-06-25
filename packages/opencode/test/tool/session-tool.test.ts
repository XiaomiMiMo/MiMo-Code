import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Actor } from "../../src/actor/spawn"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { Session } from "../../src/session"
import { MessageID, SessionID } from "../../src/session/schema"
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

        // cancel sets the registry row to idle/cancelled (Actor.cancel →
        // ActorRegistry.updateStatus). Peer actorID === sessionID === childID.
        const actor = yield* actorReg.get(SessionID.make(childID), childID)
        expect(actor!.status).toBe("idle")
        expect(actor!.lastOutcome).toBe("cancelled")
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
