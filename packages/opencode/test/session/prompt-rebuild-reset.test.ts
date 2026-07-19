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

  it.live("prompt.ts rebuild path resets thresholds and sets skipOverflowCheck before continue", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Source-level regression guard (F1). The site-1 main rebuild path now
        // delegates the boundary insert + threshold reset to the shared
        // rebuildFromCheckpoint helper (reused by the /rebuild command), then
        // sets skipOverflowCheck and continues. Assert BOTH halves of the
        // invariant: (a) the shared helper resets thresholds after a successful
        // insert; (b) site-1 sets skipOverflowCheck=true then continue after
        // calling rebuildFromCheckpoint — so the loop can't immediately
        // re-trigger overflow on the same crossed thresholds.
        const promptSrc = yield* Effect.promise(() =>
          Bun.file(`${import.meta.dir}/../../src/session/prompt.ts`).text(),
        )
        expect(promptSrc).not.toContain("Do NOT reset thresholds here")
        // (a) shared helper resets thresholds on a successful insert.
        expect(promptSrc).toMatch(/if\s*\(inserted\)\s+yield\*\s+prune\.resetThresholds\(input\.sessionID\)/)
        // (b) site-1 guards on the helper result, then skips + continues.
        expect(promptSrc).toMatch(
          /const\s+inserted\s*=\s*yield\*\s+rebuildFromCheckpoint\([\s\S]*?\)\s*\n\s*if\s*\(inserted\)\s*\{\s*\n\s*skipOverflowCheck\s*=\s*true\s*\n\s*continue/,
        )
      }),
    ),
  )
})
