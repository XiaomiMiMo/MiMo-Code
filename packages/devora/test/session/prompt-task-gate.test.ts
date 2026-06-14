import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { TaskRegistry } from "../../src/task/registry"
import { TaskGate, MAX_TASK_GATE_MAIN_REACT } from "../../src/task/gate"
import { TaskGateState } from "../../src/task/gate-state"
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
  TaskGateState.defaultLayer,
)

const it = testEffect(env)

const seed = Effect.fn("Test.seed")(function* () {
  const session = yield* Session.Service
  return yield* session.create({ title: "Main gate test" })
})

describe("main-session taskGate composition", () => {
  it.live("counter advances each nudge until cap, then allows stop", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const gateState = yield* TaskGateState.Service
        const sess = yield* seed()
        yield* reg.create({ session_id: sess.id, summary: "do thing" })

        // Simulate three stop attempts in a row, model never closes the task.
        let lastDecision
        for (let i = 0; i < MAX_TASK_GATE_MAIN_REACT + 1; i++) {
          const count = yield* gateState.get(sess.id)
          lastDecision = yield* TaskGate.decide({
            session_id: sess.id,
            owner: undefined,
            reactCount: count,
            maxReact: MAX_TASK_GATE_MAIN_REACT,
            mode: "main",
          })
          if (lastDecision.needReentry) yield* gateState.bump(sess.id)
        }
        // After MAX_TASK_GATE_MAIN_REACT bumps, decide returns capExceeded.
        if (lastDecision === undefined) throw new Error("loop did not run")
        expect(lastDecision.needReentry).toBe(false)
        expect(lastDecision.capExceeded).toBe(true)
        expect(lastDecision.incompleteTasks).toEqual(["T1"])
        expect(yield* gateState.get(sess.id)).toBe(MAX_TASK_GATE_MAIN_REACT)
      }),
    ),
  )

  it.live("closing the task before the cap clears the cycle", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const gateState = yield* TaskGateState.Service
        const sess = yield* seed()
        const t = yield* reg.create({ session_id: sess.id, summary: "ok" })

        // First attempt: nudge.
        const d1 = yield* TaskGate.decide({
          session_id: sess.id,
          owner: undefined,
          reactCount: yield* gateState.get(sess.id),
          maxReact: MAX_TASK_GATE_MAIN_REACT,
          mode: "main",
        })
        expect(d1.needReentry).toBe(true)
        yield* gateState.bump(sess.id)

        // Model "closes" the task.
        yield* reg.done({ session_id: sess.id, id: t.id })

        // Second attempt: clean.
        const d2 = yield* TaskGate.decide({
          session_id: sess.id,
          owner: undefined,
          reactCount: yield* gateState.get(sess.id),
          maxReact: MAX_TASK_GATE_MAIN_REACT,
          mode: "main",
        })
        expect(d2.needReentry).toBe(false)
        expect(d2.capExceeded).toBe(false)
      }),
    ),
  )

  it.live("session-wide owner=undefined picks up subagent-orphaned tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seed()
        // Subagent left an open task.
        yield* reg.create({ session_id: sess.id, summary: "orphan", owner: "act_99" })

        const decision = yield* TaskGate.decide({
          session_id: sess.id,
          owner: undefined,
          reactCount: 0,
          maxReact: MAX_TASK_GATE_MAIN_REACT,
          mode: "main",
        })
        expect(decision.needReentry).toBe(true)
        if (!decision.needReentry) throw new Error("unreachable")
        expect(decision.incompleteTasks).toEqual(["T1"])
        // The orphan path is exactly the case where "tasks you own" would
        // mislead — main never owned T1 (owner=act_99). The headline must
        // present the listing as session-scoped so main treats `task done`
        // and `task abandon` as equally valid responses.
        expect(decision.reentryText).toContain("tasks in this session are still unfinished")
        expect(decision.reentryText).not.toContain("tasks you own")
      }),
    ),
  )
})
