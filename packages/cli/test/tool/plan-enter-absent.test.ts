import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  await Instance.disposeAll()
})

// Guards docs/compose/spec/plan-enter-removal.md: entering plan mode is a user gesture.
describe("plan_enter removal", () => {
  it.live("plan_enter is not registered while plan_exit still is", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ids = yield* (yield* ToolRegistry.Service).ids()
        expect(ids).not.toContain("plan_enter")
        expect(ids).toContain("plan_exit")
      }),
    ),
  )
})
