import { describe, expect, test, afterEach } from "bun:test"
import { Effect } from "effect"
import * as CheckpointContext from "../../src/session/checkpoint-context"
import type { SessionID } from "../../src/session/schema"

function tmpSessionID(): SessionID {
  return ("s_" + Math.random().toString(36).slice(2, 10)) as SessionID
}

afterEach(() => {
  CheckpointContext._reset()
})

describe("CheckpointContext", () => {
  test("set + get round-trip", () => {
    const sid = tmpSessionID()
    const aid = "act_1"
    const ctx: CheckpointContext.CheckpointContext = {
      priorTitles: new Set(["Foo", "Bar"]),
      expectedRevisions: [{ id: "r1", expectedText: "hello" }],
    }
    CheckpointContext.set(sid, aid, ctx)

    const got = CheckpointContext.get(sid, aid)
    expect(got).toBeDefined()
    expect(got!.priorTitles).toEqual(new Set(["Foo", "Bar"]))
    expect(got!.expectedRevisions).toEqual([{ id: "r1", expectedText: "hello" }])
  })

  test("get returns structuredClone, mutation invisible to next get", () => {
    const sid = tmpSessionID()
    const aid = "act_clone"
    CheckpointContext.set(sid, aid, {
      priorTitles: new Set(["Foo"]),
      expectedRevisions: [{ id: "r1", expectedText: "original" }],
    })

    const first = CheckpointContext.get(sid, aid)!
    first.priorTitles.add("Bar")
    first.expectedRevisions.push({ id: "r2", expectedText: "added" })

    const second = CheckpointContext.get(sid, aid)!
    expect(second.priorTitles).toEqual(new Set(["Foo"]))
    expect(second.expectedRevisions).toEqual([{ id: "r1", expectedText: "original" }])
  })

  test("remove deletes entry", () => {
    const sid = tmpSessionID()
    const aid = "act_remove"
    CheckpointContext.set(sid, aid, {
      priorTitles: new Set(["Foo"]),
      expectedRevisions: [],
    })
    expect(CheckpointContext.get(sid, aid)).toBeDefined()

    CheckpointContext.remove(sid, aid)
    expect(CheckpointContext.get(sid, aid)).toBeUndefined()
  })

  test("get on missing entry returns undefined", () => {
    expect(CheckpointContext.get(tmpSessionID(), "act_never_set")).toBeUndefined()
  })

  test("composite key isolation across sessions and actors", () => {
    const sidA = tmpSessionID()
    const sidB = tmpSessionID()
    CheckpointContext.set(sidA, "act_X", {
      priorTitles: new Set(["FromA"]),
      expectedRevisions: [],
    })
    CheckpointContext.set(sidB, "act_X", {
      priorTitles: new Set(["FromB"]),
      expectedRevisions: [],
    })

    expect(CheckpointContext.get(sidA, "act_X")!.priorTitles).toEqual(new Set(["FromA"]))
    expect(CheckpointContext.get(sidB, "act_X")!.priorTitles).toEqual(new Set(["FromB"]))
    expect(CheckpointContext.get(sidA, "act_Y")).toBeUndefined()
  })

  test("_reset clears all entries", () => {
    const sid = tmpSessionID()
    CheckpointContext.set(sid, "act_a", { priorTitles: new Set(), expectedRevisions: [] })
    CheckpointContext.set(sid, "act_b", { priorTitles: new Set(), expectedRevisions: [] })
    expect(CheckpointContext.get(sid, "act_a")).toBeDefined()
    expect(CheckpointContext.get(sid, "act_b")).toBeDefined()

    CheckpointContext._reset()

    expect(CheckpointContext.get(sid, "act_a")).toBeUndefined()
    expect(CheckpointContext.get(sid, "act_b")).toBeUndefined()
  })

  test("Effect.ensuring cleanup runs even if surrounding Effect fails", async () => {
    const sid = tmpSessionID()
    const aid = "act_failure_path"
    CheckpointContext.set(sid, aid, {
      priorTitles: new Set(["Foo"]),
      expectedRevisions: [],
    })
    expect(CheckpointContext.get(sid, aid)).toBeDefined()

    // Mirror the orchestrator's pattern: an Effect that does some work,
    // then fails. The ensuring callback must still run.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.fail(new Error("simulated settle failure"))
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => CheckpointContext.remove(sid, aid)),
        ),
        Effect.catch(() => Effect.succeed("recovered")),
      ),
    )

    expect(CheckpointContext.get(sid, aid)).toBeUndefined()
  })

  test("Effect.ensuring cleanup runs on interrupt", async () => {
    const sid = tmpSessionID()
    const aid = "act_interrupt_path"
    CheckpointContext.set(sid, aid, {
      priorTitles: new Set(),
      expectedRevisions: [],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.interrupt
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => CheckpointContext.remove(sid, aid)),
        ),
        Effect.catch(() => Effect.succeed("recovered")),
        Effect.catchCause(() => Effect.succeed("recovered")),
      ),
    )

    expect(CheckpointContext.get(sid, aid)).toBeUndefined()
  })
})
