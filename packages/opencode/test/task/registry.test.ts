import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Layer, Stream } from "effect"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { TaskRegistry } from "../../src/task/registry"
import * as TaskEvents from "../../src/task/events"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { isRecoverableError } from "../../src/tool/recoverable"
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

const seedSession = Effect.fn("Test.seedSession")(function* () {
  const session = yield* Session.Service
  return yield* session.create({ title: "Test" })
})

describe("TaskRegistry.create", () => {
  it.live("creates a top-level task with id T1", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()

        const task = yield* reg.create({
          session_id: sess.id,
          summary: "Refactor auth",
        })
        expect(task.id).toBe("T1")
        expect(task.status).toBe("open")
        expect(task.parent_task_id).toBeUndefined()
      }),
    ),
  )

  it.live("creates sequential top-level ids T1, T2, T3", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()

        const t1 = yield* reg.create({ session_id: sess.id, summary: "a" })
        const t2 = yield* reg.create({ session_id: sess.id, summary: "b" })
        const t3 = yield* reg.create({ session_id: sess.id, summary: "c" })
        expect(t1.id).toBe("T1")
        expect(t2.id).toBe("T2")
        expect(t3.id).toBe("T3")
      }),
    ),
  )

  it.live("creates subtask T1.1 under T1", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()

        const t1 = yield* reg.create({ session_id: sess.id, summary: "parent" })
        const sub = yield* reg.create({ session_id: sess.id, summary: "child", parent_id: t1.id })
        expect(sub.id).toBe("T1.1")
        expect(sub.parent_task_id).toBe("T1")
      }),
    ),
  )

  it.live("emits 'created' task_event on create", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        expect(events.length).toBe(1)
        expect(events[0].kind).toBe("created")
      }),
    ),
  )

  it.live("two sessions can each have a T1 without colliding", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const a = yield* seedSession()
        const b = yield* seedSession()

        const ta = yield* reg.create({ session_id: a.id, summary: "in A" })
        const tb = yield* reg.create({ session_id: b.id, summary: "in B" })
        expect(ta.id).toBe("T1")
        expect(tb.id).toBe("T1")
        expect(ta.session_id).toBe(a.id)
        expect(tb.session_id).toBe(b.id)
      }),
    ),
  )
})

describe("TaskRegistry not-found is agent-recoverable", () => {
  it.live("start on a nonexistent id dies with an actionable RecoverableError", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()

        const exit = yield* Effect.exit(reg.start({ session_id: sess.id, id: "T99" }))
        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        const err = Cause.squash(exit.cause)
        expect(isRecoverableError(err)).toBe(true)
        expect((err as Error).message).toContain("task list")
      }),
    ),
  )
})

describe("TaskRegistry.list", () => {
  it.live("lists active tasks for a session by default", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.create({ session_id: sess.id, summary: "b" })

        const list = yield* reg.list({ session_id: sess.id })
        expect(list.length).toBe(2)
      }),
    ),
  )

  it.live("excludes terminal tasks by default", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t1 = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.done({ session_id: sess.id, id: t1.id })
        yield* reg.create({ session_id: sess.id, summary: "b" })

        const list = yield* reg.list({ session_id: sess.id })
        expect(list.length).toBe(1)
        expect(list[0].summary).toBe("b")
      }),
    ),
  )

  it.live("includes terminal when include_terminal=true", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t1 = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.done({ session_id: sess.id, id: t1.id })

        const list = yield* reg.list({ session_id: sess.id, include_terminal: true })
        expect(list.length).toBe(1)
      }),
    ),
  )

  it.live("treats dispatched and human_review as non-terminal, failed as terminal", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const worker = yield* seedSession()

        const dispatched = yield* reg.create({ session_id: sess.id, summary: "dispatched" })
        yield* reg.dispatch({ session_id: sess.id, id: dispatched.id, worker_session_id: worker.id })
        const review = yield* reg.create({ session_id: sess.id, summary: "review" })
        yield* reg.requestReview({ session_id: sess.id, id: review.id })
        const failed = yield* reg.create({ session_id: sess.id, summary: "failed" })
        yield* reg.fail({ session_id: sess.id, id: failed.id })

        const active = yield* reg.list({ session_id: sess.id })
        expect(active.map((t) => t.summary).sort()).toEqual(["dispatched", "review"])

        const all = yield* reg.list({ session_id: sess.id, include_terminal: true })
        expect(all.length).toBe(3)
      }),
    ),
  )

  it.live("filters by the new statuses", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const worker = yield* seedSession()
        const a = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.dispatch({ session_id: sess.id, id: a.id, worker_session_id: worker.id })
        yield* reg.create({ session_id: sess.id, summary: "b" })

        const list = yield* reg.list({ session_id: sess.id, status: "dispatched" })
        expect(list.length).toBe(1)
        expect(list[0].id).toBe(a.id)
      }),
    ),
  )
})

describe("TaskRegistry worker-session link columns", () => {
  it.live("new columns default to undefined on create and round-trip", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })
        expect(t.worker_session_id).toBeUndefined()
        expect(t.dispatched_at).toBeUndefined()
        expect(t.result_ref).toBeUndefined()

        const fetched = yield* reg.get({ session_id: sess.id, id: t.id })
        expect(fetched?.worker_session_id).toBeUndefined()
        expect(fetched?.dispatched_at).toBeUndefined()
        expect(fetched?.result_ref).toBeUndefined()
      }),
    ),
  )

  it.live("result_ref round-trips through fail()", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })
        const failed = yield* reg.fail({ session_id: sess.id, id: t.id, result_ref: "branch:wip/x" })
        expect(failed.result_ref).toBe("branch:wip/x")

        const fetched = yield* reg.get({ session_id: sess.id, id: t.id })
        expect(fetched?.result_ref).toBe("branch:wip/x")
      }),
    ),
  )
})

describe("TaskRegistry.dispatch", () => {
  it.live("sets worker_session_id + dispatched_at and moves to dispatched", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const worker = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "ship it" })

        const before = Date.now()
        const out = yield* reg.dispatch({ session_id: sess.id, id: t.id, worker_session_id: worker.id })
        expect(out.status).toBe("dispatched")
        expect(out.worker_session_id).toBe(worker.id)
        expect(out.dispatched_at).toBeGreaterThanOrEqual(before)

        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        expect(events.map((e) => e.kind)).toEqual(["created", "dispatched"])
      }),
    ),
  )

  it.live("refuses to dispatch a terminal task", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const worker = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.done({ session_id: sess.id, id: t.id })

        const out = yield* reg.dispatch({ session_id: sess.id, id: t.id, worker_session_id: worker.id })
        expect(out.status).toBe("done")
        expect(out.worker_session_id).toBeUndefined()
      }),
    ),
  )

  it.live("dispatch on a nonexistent id is agent-recoverable", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const worker = yield* seedSession()

        const exit = yield* Effect.exit(
          reg.dispatch({ session_id: sess.id, id: "T99", worker_session_id: worker.id }),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        expect(isRecoverableError(Cause.squash(exit.cause))).toBe(true)
      }),
    ),
  )
})

describe("TaskRegistry.requestReview / rework", () => {
  it.live("requestReview moves the task into the human_review queue", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.start({ session_id: sess.id, id: t.id })

        const out = yield* reg.requestReview({ session_id: sess.id, id: t.id, event_summary: "please look" })
        expect(out.status).toBe("human_review")
        expect(out.ended_at).toBeUndefined()

        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        expect(events.map((e) => e.kind)).toEqual(["created", "started", "review_requested"])
      }),
    ),
  )

  it.live("rework returns a reviewed task with a worker to dispatched", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const worker = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.dispatch({ session_id: sess.id, id: t.id, worker_session_id: worker.id })
        yield* reg.requestReview({ session_id: sess.id, id: t.id })

        const out = yield* reg.rework({ session_id: sess.id, id: t.id, event_summary: "not quite" })
        expect(out.status).toBe("dispatched")
        expect(out.worker_session_id).toBe(worker.id)

        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        expect(events.map((e) => e.kind)).toEqual(["created", "dispatched", "review_requested", "reworked"])
      }),
    ),
  )

  it.live("rework returns a reviewed task without a worker to open", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.requestReview({ session_id: sess.id, id: t.id })

        const out = yield* reg.rework({ session_id: sess.id, id: t.id })
        expect(out.status).toBe("open")
      }),
    ),
  )

  it.live("rework is a no-op when the task is not awaiting review", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })

        const out = yield* reg.rework({ session_id: sess.id, id: t.id })
        expect(out.status).toBe("open")
        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        expect(events.map((e) => e.kind)).toEqual(["created"])
      }),
    ),
  )
})

describe("TaskRegistry.fail", () => {
  it.live("marks failed and stamps ended_at + cleanup_after", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })

        const out = yield* reg.fail({ session_id: sess.id, id: t.id, event_summary: "worker crashed" })
        expect(out.status).toBe("failed")
        expect(out.ended_at).toBeGreaterThan(0)
        expect(out.cleanup_after).toBeGreaterThan(out.ended_at!)

        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        expect(events.map((e) => e.kind)).toEqual(["created", "failed"])
        expect(events[1].summary).toBe("worker crashed")
      }),
    ),
  )

  it.live("failed is terminal — start refuses to resurrect it", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.fail({ session_id: sess.id, id: t.id })

        const out = yield* reg.start({ session_id: sess.id, id: t.id })
        expect(out.status).toBe("failed")

        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        expect(events.map((e) => e.kind)).toEqual(["created", "failed"])
      }),
    ),
  )
})

describe("TaskRegistry queue transitions publish task.updated", () => {
  it.live("emits the matching kind on the bus for each new mutator", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const bus = yield* Bus.Service
        const sess = yield* seedSession()
        const worker = yield* seedSession()

        const seen: string[] = []
        yield* bus.subscribe(TaskEvents.Updated).pipe(
          Stream.runForEach((p) =>
            Effect.sync(() => {
              seen.push(p.properties.kind)
            }),
          ),
          Effect.forkScoped,
        )
        // let the forked fiber actually attach its subscription before publishing
        yield* Effect.sleep("50 millis")

        const t = yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.dispatch({ session_id: sess.id, id: t.id, worker_session_id: worker.id })
        yield* reg.requestReview({ session_id: sess.id, id: t.id })
        yield* reg.rework({ session_id: sess.id, id: t.id })
        yield* reg.fail({ session_id: sess.id, id: t.id })
        yield* Effect.sleep("50 millis")

        expect(seen).toEqual(["dispatched", "review_requested", "reworked", "failed"])
      }),
    ),
  )
})
