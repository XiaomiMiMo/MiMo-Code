import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { ActorRegistry } from "../../src/actor/registry"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const env = Layer.mergeAll(
  Session.defaultLayer,
  ActorRegistry.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(env)

describe("session.children visible filter", () => {
  it.live("visible: true returns only peer children, hides subagent hosts and orphans", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service

        const parent = yield* session.create({ title: "parent" })

        // 1. Peer child: has an actor row with mode "peer" keyed on its own id.
        const peer = yield* session.create({ parentID: parent.id as SessionID, title: "peer child" })
        yield* actorReg.register({
          sessionID: peer.id as SessionID,
          actorID: peer.id,
          mode: "peer",
          agent: "general",
          description: "peer child",
          contextMode: "none",
          contextWatermark: undefined,
          background: false,
          lifecycle: "persistent",
          tools: undefined,
        })

        // 2. Subagent host child (e.g. checkpoint-writer / ask fork / workflow agent).
        const subagentHost = yield* session.create({ parentID: parent.id as SessionID, title: "checkpoint-writer: x" })
        yield* actorReg.register({
          sessionID: subagentHost.id as SessionID,
          actorID: "checkpoint-writer-1",
          mode: "subagent",
          agent: "checkpoint-writer",
          description: "writer",
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "ephemeral",
          tools: undefined,
        })

        // 3. Orphan child: no actor row at all.
        const orphan = yield* session.create({ parentID: parent.id as SessionID, title: "orphan" })

        const all = yield* session.children(parent.id as SessionID)
        expect(all.map((s) => s.id).toSorted()).toEqual([peer.id, subagentHost.id, orphan.id].toSorted())

        const visible = yield* session.children(parent.id as SessionID, { visible: true })
        expect(visible.map((s) => s.id)).toEqual([peer.id])
      }),
    ),
  )

  it.live("visible: true with no children returns empty", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const parent = yield* session.create({ title: "lonely parent" })
        const visible = yield* session.children(parent.id as SessionID, { visible: true })
        expect(visible).toEqual([])
      }),
    ),
  )
})
