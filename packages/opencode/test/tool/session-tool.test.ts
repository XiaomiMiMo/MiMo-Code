import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { ActorRegistry } from "../../src/actor/registry"
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

  it.live("unimplemented verbs fail (switch/list/cancel are stubs)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const info = yield* SessionTool
        const tool = yield* info.init()
        const exit = yield* Effect.exit(
          tool.execute({ operation: { action: "list" } }, ctx(parent.id)),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
