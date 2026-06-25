import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Actor } from "../../src/actor/spawn"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "../../src/tool"
import { SessionTool } from "../../src/tool/session"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

// SessionPrompt.defaultLayer is self-contained — it provides its own copies of
// Session / ActorRegistry / Truncate / Agent internally. We list the ones the
// test body (and Tool.define's init) also need at top level; Effect memoizes the
// shared singleton layers so there is one Session DB / one ActorRegistry.
const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    ActorRegistry.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Bus.defaultLayer,
    // Actor.defaultLayer populates spawnRef.current, which the session tool's
    // cancel branch reads via requireActor(). Without it cancel fails fast.
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
        const bus = yield* Bus.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const target = yield* sessions.create({ title: "Target" })

        const seen: string[] = []
        yield* bus.subscribeCallback(TuiEvent.SessionSelect, (event) => seen.push(event.properties.sessionID))

        const info = yield* SessionTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: { action: "switch", sessionID: target.id } },
          ctx(parent.id),
        )

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
