import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { TaskRegistry } from "../../src/task/registry"
import { TaskGate } from "../../src/task/gate"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  Bus.defaultLayer,
  Session.defaultLayer,
  TaskRegistry.defaultLayer,
)

const it = testEffect(env)

const seed = Effect.fn("Test.seed")(function* () {
  const session = yield* Session.Service
  return yield* session.create({ title: "T" })
})

describe("TaskGate.decide", () => {
  it.live("returns needReentry=false when no actionable tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sess = yield* seed()
        const result = yield* TaskGate.decide({
          session_id: sess.id,
          owner: undefined,
          reactCount: 0,
          maxReact: 2,
        })
        expect(result.needReentry).toBe(false)
        expect(result.capExceeded).toBe(false)
        expect(result.incompleteTasks).toEqual([])
      }),
    ),
  )

  it.live("returns needReentry=true with nudge text when one open task exists", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seed()
        yield* reg.create({ session_id: sess.id, summary: "Refactor parser" })

        const result = yield* TaskGate.decide({
          session_id: sess.id,
          owner: undefined,
          reactCount: 0,
          maxReact: 2,
        })
        expect(result.needReentry).toBe(true)
        if (!result.needReentry) throw new Error("unreachable")
        expect(result.incompleteTasks).toEqual(["T1"])
        expect(result.reentryText).toContain("<system-reminder>")
        expect(result.reentryText).toContain("T1 (open): Refactor parser")
        expect(result.reentryText).toContain("`task done <id>")
        expect(result.reentryText).toContain("**Status**/**Summary**")
        expect(result.reentryText).toContain("tasks you own are still unfinished:")
      }),
    ),
  )

  it.live("returns capExceeded=true when reactCount >= maxReact", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seed()
        yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.create({ session_id: sess.id, summary: "b" })

        const result = yield* TaskGate.decide({
          session_id: sess.id,
          owner: undefined,
          reactCount: 2,
          maxReact: 2,
        })
        expect(result.needReentry).toBe(false)
        expect(result.capExceeded).toBe(true)
        expect(result.incompleteTasks).toEqual(["T1", "T2"])
      }),
    ),
  )

  it.live("filters by owner when provided", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seed()
        yield* reg.create({ session_id: sess.id, summary: "mine", owner: "actor_X" })
        yield* reg.create({ session_id: sess.id, summary: "theirs", owner: "actor_Y" })

        const result = yield* TaskGate.decide({
          session_id: sess.id,
          owner: "actor_X",
          reactCount: 0,
          maxReact: 2,
        })
        expect(result.needReentry).toBe(true)
        if (!result.needReentry) throw new Error("unreachable")
        expect(result.incompleteTasks).toEqual(["T1"])
      }),
    ),
  )

  it.live("excludes done/abandoned tasks (include_terminal:false)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seed()
        const t1 = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.done({ session_id: sess.id, id: t1.id })

        const result = yield* TaskGate.decide({
          session_id: sess.id,
          owner: undefined,
          reactCount: 0,
          maxReact: 2,
        })
        expect(result.needReentry).toBe(false)
      }),
    ),
  )
})
