import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { Session as SessionNs } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { TaskRegistry } from "../../src/task/registry"
import { ActorRegistry } from "../../src/actor/registry"
import { Instance } from "../../src/project/instance"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    Memory.defaultLayer,
    SessionNs.defaultLayer,
    TaskRegistry.defaultLayer,
    ActorRegistry.defaultLayer,
    SessionCheckpoint.defaultLayer,
  ),
)

async function seedUserMessage(sessionID: SessionID, text: string) {
  const msg = await Effect.runPromise(
    SessionNs.Service.use((s) =>
      s.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      }),
    ).pipe(Effect.provide(SessionNs.defaultLayer)),
  )
  await Effect.runPromise(
    SessionNs.Service.use((s) =>
      s.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
      }),
    ).pipe(Effect.provide(SessionNs.defaultLayer)),
  )
  return msg
}

describe("renderRebuildContext — recent user input section", () => {
  it.live(
    "under-budget passthrough: small messages all appear verbatim",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const ssn = yield* SessionNs.Service
        const sess = yield* ssn.create({})
        yield* Effect.promise(() => seedUserMessage(sess.id, "first prompt about authentication"))
        yield* Effect.promise(() => seedUserMessage(sess.id, "second prompt asking for tests"))
        yield* Effect.promise(() => seedUserMessage(sess.id, "third prompt — please commit"))

        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).toContain("## Recent user input (verbatim)")
        expect(out).toContain("first prompt about authentication")
        expect(out).toContain("second prompt asking for tests")
        expect(out).toContain("third prompt — please commit")
        expect(out).not.toContain("…elided")
      }),
    ),
  )

  it.live(
    "per-message overflow truncation emits messageID-bearing marker",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const ssn = yield* SessionNs.Service
        const sess = yield* ssn.create({})
        const head = "HEAD-MARKER-XYZZY " + "padding ".repeat(800)
        const tail = "padding ".repeat(800) + " TAIL-MARKER-PLUGH"
        const middle = "middle-noise ".repeat(2000)
        const m = yield* Effect.promise(() => seedUserMessage(sess.id, head + "\n" + middle + "\n" + tail))

        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).toContain("## Recent user input (verbatim)")
        expect(out).toContain("HEAD-MARKER-XYZZY")
        expect(out).toContain("TAIL-MARKER-PLUGH")
        expect(out).not.toContain("middle-noise middle-noise middle-noise")
        expect(out).toContain("…elided")
        expect(out).toContain(m.id)
        expect(out).toContain("history tool")
      }),
    ),
  )

  it.live(
    "total-budget FIFO eviction: oldest dropped when over cap",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const ssn = yield* SessionNs.Service
        const sess = yield* ssn.create({})
        const tag = (i: number) => `MARKER-MSG-${i.toString().padStart(2, "0")}`
        const body = "x ".repeat(2500)
        for (let i = 0; i < 20; i++) {
          yield* Effect.promise(() => seedUserMessage(sess.id, `${tag(i)} ${body}`))
        }

        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).toContain("## Recent user input (verbatim)")
        expect(out).toContain("MARKER-MSG-19")
        expect(out).not.toContain("MARKER-MSG-00")
      }),
    ),
  )

  it.live(
    "disabled when recent_user cap = 0",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const cp = yield* SessionCheckpoint.Service
          const ssn = yield* SessionNs.Service
          const sess = yield* ssn.create({})
          yield* Effect.promise(() => seedUserMessage(sess.id, "this should not appear"))

          const out = yield* cp.renderRebuildContext(sess.id)
          expect(out).not.toContain("Recent user input")
          expect(out).not.toContain("this should not appear")
        }),
      { config: { checkpoint: { push_caps: { recent_user: 0 } } } },
    ),
  )
})
