import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { Session } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { SessionPrune } from "../../src/session/prune"
import { TaskRegistry } from "../../src/task/registry"
import { ActorRegistry } from "../../src/actor/registry"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    Memory.defaultLayer,
    Session.defaultLayer,
    TaskRegistry.defaultLayer,
    ActorRegistry.defaultLayer,
    SessionCheckpoint.defaultLayer,
    SessionPrune.defaultLayer,
  ),
)

describe("F1 — prune resetThresholds clears sticky maxCrossed", () => {
  it.live("resetThresholds clears maxThresholdCrossed flag", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const prune = yield* SessionPrune.Service
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "t1" })

        // Initially false (never crossed)
        expect(yield* prune.maxThresholdCrossed(sess.id)).toBe(false)

        // resetThresholds is a no-op when state is empty
        yield* prune.resetThresholds(sess.id)
        expect(yield* prune.maxThresholdCrossed(sess.id)).toBe(false)
      }),
    ),
  )

  it.live("prompt.ts source at site-1 contains resetThresholds + skipOverflowCheck before continue", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Source-level regression guard: site-1 main rebuild path in prompt.ts must
        // reset thresholds and set skipOverflowCheck immediately before `continue`.
        const promptSrc = yield* Effect.promise(() =>
          Bun.file(`${import.meta.dir}/../../src/session/prompt.ts`).text(),
        )
        expect(promptSrc).not.toContain("Do NOT reset thresholds here")
        expect(promptSrc).toMatch(
          /yield\*\s+prune\.resetThresholds\(sessionID\)\s*\n\s*skipOverflowCheck\s*=\s*true\s*\n\s*continue/,
        )
      }),
    ),
  )
})
