import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { TaskGateState } from "../../src/task/gate-state"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type { SessionID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(CrossSpawnSpawner.defaultLayer, TaskGateState.defaultLayer)
const it = testEffect(env)

const sid = "ses_test_1" as SessionID

describe("TaskGateState", () => {
  it.live("get returns 0 for unseen session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const state = yield* TaskGateState.Service
        expect(yield* state.get(sid)).toBe(0)
      }),
    ),
  )

  it.live("bump increments and returns new count", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const state = yield* TaskGateState.Service
        expect(yield* state.bump(sid)).toBe(1)
        expect(yield* state.bump(sid)).toBe(2)
        expect(yield* state.get(sid)).toBe(2)
      }),
    ),
  )

  it.live("clear resets count", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const state = yield* TaskGateState.Service
        yield* state.bump(sid)
        yield* state.bump(sid)
        yield* state.clear(sid)
        expect(yield* state.get(sid)).toBe(0)
      }),
    ),
  )

  it.live("counters are isolated per session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const state = yield* TaskGateState.Service
        const a = "ses_a" as SessionID
        const b = "ses_b" as SessionID
        yield* state.bump(a)
        yield* state.bump(a)
        yield* state.bump(b)
        expect(yield* state.get(a)).toBe(2)
        expect(yield* state.get(b)).toBe(1)
      }),
    ),
  )
})
