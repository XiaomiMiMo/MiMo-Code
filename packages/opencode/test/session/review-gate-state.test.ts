/**
 * Unit tests for the per-session auto-review gate state (session/review-gate-state.ts).
 * Mirrors the TaskGateState test style: InstanceState-backed, per-session counters.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ReviewGateState } from "../../src/session/review-gate-state"
import { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const ses = SessionID.make("ses_review_state")

function runState<A>(dir: string, fn: (svc: ReviewGateState.Interface) => Effect.Effect<A>) {
  return Instance.provide({
    directory: dir,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* ReviewGateState.Service
          return yield* fn(svc)
        }).pipe(Effect.scoped, Effect.provide(ReviewGateState.defaultLayer)),
      ),
  })
}

describe("ReviewGateState", () => {
  test("get returns 0 before any bump", async () => {
    await using tmp = await tmpdir({})
    const got = await runState(tmp.path, (svc) => svc.get(ses))
    expect(got).toBe(0)
  })

  test("bump increments, clear resets", async () => {
    await using tmp = await tmpdir({})
    const got = await runState(tmp.path, (svc) =>
      Effect.gen(function* () {
        const a = yield* svc.bump(ses)
        const b = yield* svc.bump(ses)
        yield* svc.clear(ses)
        const c = yield* svc.get(ses)
        return { a, b, c }
      }),
    )
    expect(got).toEqual({ a: 1, b: 2, c: 0 })
  })

  test("last-reviewed hash round-trips and clears", async () => {
    await using tmp = await tmpdir({})
    const got = await runState(tmp.path, (svc) =>
      Effect.gen(function* () {
        yield* svc.setLastReviewedHash(ses, "abc")
        const before = yield* svc.getLastReviewedHash(ses)
        yield* svc.clear(ses)
        const after = yield* svc.getLastReviewedHash(ses)
        return { before, after }
      }),
    )
    expect(got).toEqual({ before: "abc", after: undefined })
  })

  test("in-flight marker round-trips and clears", async () => {
    await using tmp = await tmpdir({})
    const got = await runState(tmp.path, (svc) =>
      Effect.gen(function* () {
        yield* svc.setInFlight(ses, true)
        const during = yield* svc.inFlight(ses)
        yield* svc.setInFlight(ses, false)
        const after = yield* svc.inFlight(ses)
        return { during, after }
      }),
    )
    expect(got).toEqual({ during: true, after: false })
  })

  test("per-session isolation", async () => {
    await using tmp = await tmpdir({})
    const other = SessionID.make("ses_other")
    const got = await runState(tmp.path, (svc) =>
      Effect.gen(function* () {
        yield* svc.bump(ses)
        yield* svc.setLastReviewedHash(ses, "x")
        return {
          otherCount: yield* svc.get(other),
          otherHash: yield* svc.getLastReviewedHash(other),
        }
      }),
    )
    expect(got).toEqual({ otherCount: 0, otherHash: undefined })
  })
})
