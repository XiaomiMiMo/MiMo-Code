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

describe("F1 — rebuild resets checkpoint thresholds", () => {
  it.live("prompt.ts rebuild path resets thresholds and sets skipOverflowCheck before continue", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Source-level regression guard (F1). The site-1 main rebuild path now
        // delegates the boundary insert + threshold reset to the shared
        // rebuildFromCheckpoint helper, which is itself wrapped by
        // rebuildEnsuringCheckpoint (the start-a-writer-and-wait step reused by
        // the /rebuild command). Assert BOTH halves of the invariant: (a) the
        // shared helper resets thresholds after a successful insert; (b) site-1
        // sets skipOverflowCheck=true then continue on a successful rebuild — so
        // the loop can't immediately re-trigger overflow on the same token
        // count.
        //
        // DELIBERATE UPDATE: (b)'s pattern used to be
        //   const inserted = yield* rebuildFromCheckpoint(…)
        //   if (inserted) { skipOverflowCheck = true; continue }
        // Site-1 now calls rebuildEnsuringCheckpoint and branches on a
        // discriminated outcome instead of a boolean, so the old regex matched a
        // code shape that no longer exists. The INVARIANT is unchanged and still
        // asserted; only the shape it is expressed in moved.
        const promptSrc = yield* Effect.promise(() =>
          Bun.file(`${import.meta.dir}/../../src/session/prompt.ts`).text(),
        )
        expect(promptSrc).not.toContain("Do NOT reset thresholds here")
        // (a) shared helper resets thresholds on a successful insert.
        expect(promptSrc).toMatch(/if\s*\(inserted\)\s+yield\*\s+prune\.resetThresholds\(input\.sessionID\)/)
        // (b) site-1 guards on the helper's outcome, then skips + continues.
        expect(promptSrc).toMatch(
          /const\s+attempt:\s*RebuildAttempt\s*=\s*yield\*\s+rebuildEnsuringCheckpoint\([\s\S]*?\)\s*\n\s*if\s*\(attempt\s*===\s*"rebuilt"\)\s*\{\s*\n\s*skipOverflowCheck\s*=\s*true\s*\n\s*continue/,
        )
      }),
    ),
  )
})
