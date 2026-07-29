import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

const userAt = (sessionID: MessageV2.User["sessionID"], created: number) => ({
  id: MessageID.ascending(),
  role: "user" as const,
  sessionID,
  agent: "default",
  model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
  time: { created },
})

// A fork's inherited-context boundary is stored as a MESSAGE ID
// (actor_registry.context_watermark, captured from Session.lastMainMessageID).
// SessionProcessor.cleanup's empty-shell guard and sweepOrphanAssistants both
// DELETE assistant rows, so that stored id can outlive the row it names — and a
// spawn issued from inside a turn captures precisely the row most likely to be
// deleted: that turn's own in-flight assistant.
describe("filterCompactedEffect contextWatermark", () => {
  it.live("truncates at the boundary even after the watermark row is deleted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({})
        const child = yield* sessions.create({})

        const first = yield* sessions.updateMessage(userAt(parent.id, Date.now() - 5_000))
        const boundary = yield* sessions.updateMessage(userAt(parent.id, Date.now() - 4_000))
        const afterBoundary = yield* sessions.updateMessage(userAt(parent.id, Date.now() - 3_000))

        // Sanity: with the row present, the watermark resolves and truncates.
        const resolved = yield* MessageV2.filterCompactedEffect(child.id, {
          contextFrom: parent.id,
          contextWatermark: boundary.id,
        })
        expect(resolved.map((m) => m.info.id)).toEqual([first.id, boundary.id])

        // Now the boundary row is gone, exactly as the empty-shell guard leaves it.
        yield* sessions.removeMessage({ sessionID: parent.id, messageID: boundary.id })

        const dangling = yield* MessageV2.filterCompactedEffect(child.id, {
          contextFrom: parent.id,
          contextWatermark: boundary.id,
        })
        // The boundary must still hold: `first` is inherited, `afterBoundary` is NOT.
        // Falling back to the full parent history would hand the child context it
        // was never registered for.
        expect(dangling.map((m) => m.info.id)).toEqual([first.id])
        expect(dangling.some((m) => m.info.id === afterBoundary.id)).toBe(false)
      }),
    ),
  )

  it.live("inherits nothing when the deleted watermark predates every surviving message", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({})
        const child = yield* sessions.create({})

        const boundary = yield* sessions.updateMessage(userAt(parent.id, Date.now() - 5_000))
        const later = yield* sessions.updateMessage(userAt(parent.id, Date.now() - 4_000))

        yield* sessions.removeMessage({ sessionID: parent.id, messageID: boundary.id })

        const msgs = yield* MessageV2.filterCompactedEffect(child.id, {
          contextFrom: parent.id,
          contextWatermark: boundary.id,
        })
        expect(msgs.some((m) => m.info.id === later.id)).toBe(false)
        expect(msgs).toHaveLength(0)
      }),
    ),
  )
})
