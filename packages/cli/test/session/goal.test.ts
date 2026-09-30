/**
 * Unit tests for the per-session goal stop-condition service (session/goal.ts).
 *
 * Covers the state machine (set / get / clear / bumpReact) — the deterministic
 * logic that drives the main runLoop's goal gate. The judge model call
 * (Goal.evaluate) is exercised by the integration path in prompt.ts and the live
 * headless harness; it converts the conversation to native model messages (tool
 * calls/results/images preserved) rather than flattening to text.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Goal } from "../../src/session/goal"
import { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const ses = SessionID.make("ses_goal_test")

function runGoal<A>(dir: string, fn: (goal: Goal.Interface) => Effect.Effect<A>) {
  return Instance.provide({
    directory: dir,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const goal = yield* Goal.Service
          return yield* fn(goal)
        }).pipe(Effect.scoped, Effect.provide(Goal.defaultLayer)),
      ),
  })
}

describe("Goal state machine", () => {
  test("set then get returns the condition with react=0", async () => {
    await using tmp = await tmpdir({})
    const got = await runGoal(tmp.path, (goal) =>
      Effect.gen(function* () {
        yield* goal.set(ses, "tests pass")
        return yield* goal.get(ses)
      }),
    )
    expect(got?.condition).toBe("tests pass")
    expect(got?.react).toBe(0)
  })

  test("get with no goal returns undefined", async () => {
    await using tmp = await tmpdir({})
    const got = await runGoal(tmp.path, (goal) => goal.get(ses))
    expect(got).toBeUndefined()
  })

  test("clear removes the goal", async () => {
    await using tmp = await tmpdir({})
    const got = await runGoal(tmp.path, (goal) =>
      Effect.gen(function* () {
        yield* goal.set(ses, "build green")
        yield* goal.clear(ses)
        return yield* goal.get(ses)
      }),
    )
    expect(got).toBeUndefined()
  })

  test("bumpReact increments and is reflected in get", async () => {
    await using tmp = await tmpdir({})
    const result = await runGoal(tmp.path, (goal) =>
      Effect.gen(function* () {
        yield* goal.set(ses, "x")
        const first = yield* goal.bumpReact(ses)
        const second = yield* goal.bumpReact(ses)
        const current = yield* goal.get(ses)
        return { first, second, current: current?.react }
      }),
    )
    expect(result.first).toBe(1)
    expect(result.second).toBe(2)
    expect(result.current).toBe(2)
  })

  test("bumpReact with no active goal returns 0", async () => {
    await using tmp = await tmpdir({})
    const n = await runGoal(tmp.path, (goal) => goal.bumpReact(ses))
    expect(n).toBe(0)
  })

  test("set resets react back to 0", async () => {
    await using tmp = await tmpdir({})
    const got = await runGoal(tmp.path, (goal) =>
      Effect.gen(function* () {
        yield* goal.set(ses, "a")
        yield* goal.bumpReact(ses)
        yield* goal.set(ses, "b")
        return yield* goal.get(ses)
      }),
    )
    expect(got?.condition).toBe("b")
    expect(got?.react).toBe(0)
  })
})
