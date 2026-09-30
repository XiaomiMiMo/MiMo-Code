import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { TaskRegistry } from "../../src/task/registry"
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

const seedSession = Effect.fn("Test.seedSession")(function* () {
  const session = yield* Session.Service
  return yield* session.create({ title: "Test" })
})


describe("TaskRegistry.done", () => {
  it.live("transitions open → done, sets ended_at and cleanup_after", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        const done = yield* reg.done({ session_id: sess.id, id: t.id })
        expect(done.status).toBe("done")
        expect(done.ended_at).toBeGreaterThan(0)
        expect(done.cleanup_after).toBeGreaterThan(done.ended_at!)
      }),
    ),
  )
})

describe("TaskRegistry.abandon", () => {
  it.live("transitions open → abandoned, sets ended_at and cleanup_after", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        const abandoned = yield* reg.abandon({ session_id: sess.id, id: t.id })
        expect(abandoned.status).toBe("abandoned")
        expect(abandoned.ended_at).toBeGreaterThan(0)
        expect(abandoned.cleanup_after).toBeGreaterThan(abandoned.ended_at!)
      }),
    ),
  )
})

describe("TaskRegistry.block / unblock", () => {
  it.live("open → blocked → open", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        const blocked = yield* reg.block({ session_id: sess.id, id: t.id, event_summary: "waiting" })
        expect(blocked.status).toBe("blocked")
        const unblocked = yield* reg.unblock({ session_id: sess.id, id: t.id })
        expect(unblocked.status).toBe("open")
      }),
    ),
  )

  it.live("emits blocked/unblocked events with summaries", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        yield* reg.block({ session_id: sess.id, id: t.id, event_summary: "waiting on X" })
        yield* reg.unblock({ session_id: sess.id, id: t.id, event_summary: "X done" })
        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        const blocked = events.find((e) => e.kind === "blocked")
        const unblocked = events.find((e) => e.kind === "unblocked")
        expect(blocked?.summary).toBe("waiting on X")
        expect(unblocked?.summary).toBe("X done")
      }),
    ),
  )
})

describe("TaskRegistry.rename", () => {
  it.live("changes summary, emits 'renamed' event", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        const renamed = yield* reg.rename({ session_id: sess.id, id: t.id, summary: "new title" })
        expect(renamed.summary).toBe("new title")
        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        expect(events.some((e) => e.kind === "renamed")).toBe(true)
      }),
    ),
  )
})

describe("TaskRegistry.start", () => {
  it.live("transitions open → in_progress and sets owner", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        const started = yield* reg.start({ session_id: sess.id, id: t.id, owner: "main" })
        expect(started.status).toBe("in_progress")
        expect(started.owner).toBe("main")
      }),
    ),
  )

  it.live("does not enforce single in_progress (two tasks both in_progress)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const a = yield* reg.create({ session_id: sess.id, summary: "a" })
        const b = yield* reg.create({ session_id: sess.id, summary: "b" })
        yield* reg.start({ session_id: sess.id, id: a.id, owner: "explore-1" })
        const bStarted = yield* reg.start({ session_id: sess.id, id: b.id, owner: "explore-2" })
        expect(bStarted.status).toBe("in_progress")
        const aFresh = yield* reg.get({ session_id: sess.id, id: a.id })
        expect(aFresh?.status).toBe("in_progress")
      }),
    ),
  )

  it.live("refuses to start a done task (no zombie resurrection) and keeps ended_at intact", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        const done = yield* reg.done({ session_id: sess.id, id: t.id })
        const reStart = yield* reg.start({ session_id: sess.id, id: t.id, owner: "intruder" })
        // No-op: status stays done, owner not overwritten, ended_at/cleanup_after intact.
        expect(reStart.status).toBe("done")
        expect(reStart.ended_at).toBe(done.ended_at)
        expect(reStart.cleanup_after).toBe(done.cleanup_after)
        const fresh = yield* reg.get({ session_id: sess.id, id: t.id })
        expect(fresh?.status).toBe("done")
        // No spurious 'started' event emitted for the refused transition.
        const events = yield* reg.events({ session_id: sess.id, task_id: t.id })
        expect(events.some((e) => e.kind === "started")).toBe(false)
      }),
    ),
  )

  it.live("refuses to start an abandoned task", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        yield* reg.abandon({ session_id: sess.id, id: t.id })
        const reStart = yield* reg.start({ session_id: sess.id, id: t.id, owner: "intruder" })
        expect(reStart.status).toBe("abandoned")
      }),
    ),
  )

  it.live("idempotent re-start by same owner emits no duplicate 'started' event", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        yield* reg.start({ session_id: sess.id, id: t.id, owner: "main" })
        const again = yield* reg.start({ session_id: sess.id, id: t.id, owner: "main" })
        expect(again.status).toBe("in_progress")
        expect(again.owner).toBe("main")
        const started = (yield* reg.events({ session_id: sess.id, task_id: t.id })).filter(
          (e) => e.kind === "started",
        )
        expect(started.length).toBe(1)
      }),
    ),
  )

  it.live("re-start by a different owner is a handoff: updates owner, re-emits 'started'", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        yield* reg.start({ session_id: sess.id, id: t.id, owner: "first" })
        const handoff = yield* reg.start({ session_id: sess.id, id: t.id, owner: "second" })
        expect(handoff.status).toBe("in_progress")
        expect(handoff.owner).toBe("second")
        const started = (yield* reg.events({ session_id: sess.id, task_id: t.id })).filter(
          (e) => e.kind === "started",
        )
        expect(started.length).toBe(2)
      }),
    ),
  )
})

describe("TaskRegistry.list includes in_progress by default", () => {
  it.live("a started task stays in the default (non-terminal) list", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "work" })
        yield* reg.start({ session_id: sess.id, id: t.id, owner: "main" })
        const listed = yield* reg.list({ session_id: sess.id })
        expect(listed.map((x) => x.id)).toContain(t.id)
        expect(listed.find((x) => x.id === t.id)?.status).toBe("in_progress")
      }),
    ),
  )
})

describe("TaskRegistry transitions from in_progress", () => {
  it.live("done transitions in_progress → done", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        yield* reg.start({ session_id: sess.id, id: t.id, owner: "main" })
        const done = yield* reg.done({ session_id: sess.id, id: t.id })
        expect(done.status).toBe("done")
      }),
    ),
  )

  it.live("block transitions in_progress → blocked", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        yield* reg.start({ session_id: sess.id, id: t.id, owner: "main" })
        const blocked = yield* reg.block({ session_id: sess.id, id: t.id })
        expect(blocked.status).toBe("blocked")
      }),
    ),
  )
})

describe("Task 4-state machine (post-redesign)", () => {
  it.live("create starts in open status", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        expect(t.status).toBe("open")
      }),
    ),
  )

  it.live("block transitions open -> blocked", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        const blocked = yield* reg.block({ session_id: sess.id, id: t.id, event_summary: "waiting" })
        expect(blocked.status).toBe("blocked")
      }),
    ),
  )

  it.live("unblock transitions blocked -> open", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* TaskRegistry.Service
        const sess = yield* seedSession()
        const t = yield* reg.create({ session_id: sess.id, summary: "x" })
        yield* reg.block({ session_id: sess.id, id: t.id })
        const open = yield* reg.unblock({ session_id: sess.id, id: t.id })
        expect(open.status).toBe("open")
      }),
    ),
  )
})
