import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Session } from "../../src/session"
import { SessionRequests } from "../../src/session/requests"
import { SessionRunState } from "../../src/session/run-state"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Instance } from "../../src/project/instance"
import { Inbox } from "../../src/inbox"
import { sessionPromptRef } from "../../src/inbox/inbox-ref"

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    SessionRequests.defaultLayer,
    SessionRunState.defaultLayer,
    Inbox.defaultLayer,
    Bus.layer,
    CrossSpawnSpawner.defaultLayer,
  ),
)
const sid = SessionID.make("ses_request_test")
const output = (sessionID = sid): MessageV2.WithParts => ({
  info: {
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    parentID: MessageID.ascending(),
    agent: "build",
    agentID: "main",
    mode: "build",
    modelID: ModelID.make("model"),
    providerID: ProviderID.make("test"),
    path: { cwd: "/tmp/example", root: "/tmp/example" },
    time: { created: 1, completed: 2 },
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [],
})
const wait = (
  requests: SessionRequests.Service["Service"],
  sid: SessionID,
  id: string,
  predicate = (info: SessionRequests.Info) => ["completed", "failed", "cancelled"].includes(info.status),
) =>
  Effect.gen(function* () {
    for (;;) {
      const info = yield* requests.get(sid, id)
      if (predicate(info)) return info
      yield* Effect.sleep("5 millis")
    }
  }).pipe(Effect.timeout("3 seconds"))

// [TP-RUN-R13-02][TP-RUN-R13-03][TP-RUN-R13-05][TP-RUN-R13-08]
it.live("requests deduplicate concurrent submissions, retain no-message failures and immutable versions", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const requests = yield* SessionRequests.Service
      const bus = yield* Bus.Service
      const { runtimeID } = yield* requests.list(sid)
      const events: SessionRequests.Info[] = []
      const off = yield* bus.subscribeCallback(SessionRequests.Updated, (event) => events.push(event.properties))
      yield* Effect.addFinalizer(() => Effect.sync(off))
      let calls = 0
      const input = {
        sessionID: sid,
        runtimeID,
        requestID: "failure",
        kind: "send" as const,
        payload: { model: "test/model", parts: ["private input"] },
      }
      const work = Effect.sync(() => {
        calls++
        throw new Error("preparation failed")
      })
      const replies = yield* Effect.all(
        [
          requests.submit(input, work),
          requests.submit({ ...input, payload: { parts: ["private input"], model: "test/model" } }, work),
        ],
        { concurrency: "unbounded" },
      )
      const final = yield* wait(requests, sid, input.requestID)
      expect(calls).toBe(1)
      expect(final.status).toBe("failed")
      expect(final.assistantMessageIDs).toBeUndefined()
      expect(final.error).toEqual({ name: "UnknownError", data: { message: "Request failed." } })
      expect(final.version).toBeGreaterThan(replies[0]!.version)
      expect(JSON.stringify(final)).not.toContain("private input")
      expect(yield* requests.submit(input, work)).toEqual(final)
      const conflict = yield* requests.submit({ ...input, payload: { model: "test/other" } }, work).pipe(Effect.exit)
      expect(Exit.isFailure(conflict) && Cause.squash(conflict.cause)).toMatchObject({ status: 409 })
      expect(calls).toBe(1)
      expect(events.some((event) => event.status === "failed")).toBe(true)
      expect(yield* requests.get(sid, input.requestID)).toEqual(final)
    }),
  ),
)

// [TP-RUN-R13-01][TP-RUN-R13-04] Cascaded child work cannot replace the owning request's parent.
for (const agentID of ["main", "worker"])
  it.live(`validated parent stays within request agent ${agentID}`, () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const requests = yield* SessionRequests.Service
        const { runtimeID } = yield* requests.list(sid)
        const parent = MessageID.ascending()
        yield* requests.submit(
          { sessionID: sid, runtimeID, requestID: "parent", kind: "resume", agentID, payload: {} },
          Effect.gen(function* () {
            yield* requests.user(sid, parent, agentID)
            yield* requests.user(sid, MessageID.ascending(), agentID === "main" ? "worker" : "main")
          }),
        )
        const result = yield* wait(requests, sid, "parent")
        expect(result.status).toBe("completed")
        expect(result.userMessageID).toBe(parent)
      }),
    ),
  )

// [TP-RUN-R13-09]
it.live("resume-derived inbox wake clears Current and starts its own Running without changing resume parent", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const requests = yield* SessionRequests.Service
      const runs = yield* SessionRunState.Service
      const inbox = yield* Inbox.Service
      const session = yield* (yield* Session.Service).create()
      const sid = session.id
      const { runtimeID } = yield* requests.list(sid)
      const gate = yield* Deferred.make<void>()
      const woke = yield* Deferred.make<NonNullable<Effect.Success<ReturnType<typeof requests.snapshot>>>>()
      const previous = sessionPromptRef.current
      yield* Effect.addFinalizer(() => Effect.sync(() => { sessionPromptRef.current = previous }))
      sessionPromptRef.current = {
        loop: () => Effect.gen(function* () {
          yield* Deferred.await(gate)
          expect(yield* SessionRequests.Current).toBeUndefined()
          return yield* runs.ensureRunning(sid, "main", Effect.succeed(output(sid)), Effect.gen(function* () {
            expect(yield* SessionRequests.Current).toBeUndefined()
            const snapshot = yield* requests.snapshot("inbox-parent")
            yield* Deferred.succeed(woke, snapshot!)
            return output(sid)
          }))
        }),
      }
      yield* requests.submit(
        { sessionID: sid, runtimeID, requestID: "resume", kind: "resume", payload: {} },
        runs.ensureRunning(sid, "main", Effect.succeed(output(sid)), Effect.gen(function* () {
          yield* requests.user(sid, "original-parent")
          yield* requests.consume(sid, "main", ["original-parent"])
          expect((yield* requests.snapshot("original-parent"))?.requestIDs).toEqual(["resume"])
          yield* inbox.send({ receiverSessionID: sid, receiverActorID: "main", content: "background wake" }).pipe(Effect.orDie)
          return output(sid)
        })),
      )
      const resumed = yield* wait(requests, sid, "resume")
      expect(resumed.status).toBe("completed")
      expect(resumed.userMessageID).toBe("original-parent")
      yield* Deferred.succeed(gate, undefined)
      const background = yield* Deferred.await(woke).pipe(Effect.timeout("3 seconds"))
      expect(background.requestIDs).toEqual([])
      expect(background.userMessageID).toBe("inbox-parent")
      expect(background.executionRef.executionID).not.toBe(resumed.executionRefs[0]!.executionID)
      expect(yield* requests.get(sid, "resume")).toEqual(resumed)
    }),
  ),
)

// [TP-RUN-R13-09]
it.live("tool execution snapshot requires Running, never Current or the latest request", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const requests = yield* SessionRequests.Service
      const { runtimeID } = yield* requests.list(sid)
      expect(yield* requests.snapshot("parent")).toBeUndefined()
      yield* requests.submit(
        { sessionID: sid, runtimeID, requestID: "resume", kind: "resume", payload: {} },
        Effect.gen(function* () {
          expect(yield* requests.snapshot("parent")).toBeUndefined()
          yield* requests.user(sid, "parent")
        }),
      )
      expect((yield* wait(requests, sid, "resume")).userMessageID).toBe("parent")
      const execution = yield* requests.start(sid, "main")
      const snapshot = yield* requests.snapshot("background-parent").pipe(Effect.provideService(SessionRequests.Running, execution))
      expect(snapshot).toEqual({ executionRef: execution.ref, requestIDs: [], userMessageID: "background-parent" })
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot!.executionRef)).toBe(true)
      expect(Object.isFrozen(snapshot!.requestIDs)).toBe(true)
      yield* requests.finish(execution, Exit.succeed(undefined))
    }),
  ),
)

// [TP-RUN-R13-09][TP-RUN-R13-01][TP-RUN-R13-03] Multiple user inputs really consumed by one Runner share its execution reference.
it.live("send and steer associate at consumption, not pending Runner attachment", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const requests = yield* SessionRequests.Service
      const runs = yield* SessionRunState.Service
      const sid = (yield* (yield* Session.Service).create({ title: "request execution" })).id
      const { runtimeID } = yield* requests.list(sid)
      const started = yield* Deferred.make<void>()
      const consumeSteer = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const u = MessageID.ascending(),
        v = MessageID.ascending()
      const result = output(sid)
      yield* requests.submit(
        { sessionID: sid, runtimeID, requestID: "send", kind: "send", payload: {} },
        Effect.gen(function* () {
          yield* requests.user(sid, u)
          return yield* runs.ensureRunning(
            sid,
            "main",
            Effect.succeed(output(sid)),
            Effect.gen(function* () {
              yield* requests.consume(sid, "main", [u])
              const first = yield* requests.snapshot(u)
              expect(first?.requestIDs).toEqual(["send"])
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(consumeSteer)
              expect((yield* requests.snapshot(u))?.requestIDs).toEqual(["send"])
              yield* requests.consume(sid, "main", [u, v], result.info.id)
              const second = yield* requests.snapshot(v)
              expect(second?.requestIDs).toEqual(["send", "steer"])
              expect(second?.userMessageID).toBe(v)
              expect(first?.requestIDs).toEqual(["send"])
              expect(first?.userMessageID).toBe(u)
              expect(Object.isFrozen(second)).toBe(true)
              expect(Object.isFrozen(second!.requestIDs)).toBe(true)
              expect(Object.isFrozen(second!.executionRef)).toBe(true)
              expect(Reflect.set(second!.executionRef, "executionID", "forged")).toBe(false)
              expect((yield* requests.snapshot("inbox-parent"))?.requestIDs).toEqual(["send", "steer"])
              expect((yield* requests.snapshot("inbox-parent"))?.userMessageID).toBe("inbox-parent")
              yield* Deferred.await(done)
              return result
            }),
          )
        }),
      )
      yield* Deferred.await(started)
      yield* requests.submit(
        { sessionID: sid, runtimeID, requestID: "steer", kind: "steer", payload: {} },
        Effect.gen(function* () {
          yield* requests.user(sid, v)
          return yield* runs.ensureRunning(sid, "main", Effect.succeed(output(sid)), Effect.succeed(result))
        }),
      )
      yield* wait(requests, sid, "steer", (info) => info.userMessageID === v)
      expect((yield* requests.get(sid, "steer")).status).toBe("accepted")
      yield* Deferred.succeed(consumeSteer, undefined)
      const steer = yield* wait(requests, sid, "steer", (info) => info.status === "handed-off")
      const send = yield* requests.get(sid, "send")
      expect(steer.executionRefs).toEqual(send.executionRefs)
      expect(steer.executionRefs[0]).toMatchObject({ runtimeID, sessionID: sid, agentID: "main" })
      expect(steer.assistantMessageIDs).toEqual([result.info.id])
      yield* Deferred.succeed(done, undefined)
      const finished = yield* wait(requests, sid, "send")
      expect(finished.error).toBeUndefined()
      expect(finished.status).toBe("completed")
      expect((yield* wait(requests, sid, "steer")).status).toBe("completed")
    }),
  ),
)

// [TP-RUN-R13-06] submission waiters do not own a handed-off Runner's terminal state.
for (const waiter of ["returned", "interrupted"] as const) {
  it.live(`${waiter} resume waiter cannot settle before Runner finalizers`, () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const requests = yield* SessionRequests.Service
        const runs = yield* SessionRunState.Service
        const bus = yield* Bus.Service
        const sid = (yield* (yield* Session.Service).create({ title: "finalizer ownership" })).id
        const { runtimeID } = yield* requests.list(sid)
        const gate = yield* Deferred.make<void>()
        const finalizing = yield* Deferred.make<void>()
        const ready = yield* Deferred.make<{ fiber?: Fiber.Fiber<unknown, unknown> }>()
        const events: SessionRequests.Info[] = []
        const off = yield* bus.subscribeCallback(SessionRequests.Updated, (event) => {
          if (event.properties.requestID === "resume") events.push(event.properties)
        })
        yield* Effect.addFinalizer(() => Effect.sync(off))
        yield* Effect.gen(function* () {
          yield* requests.submit(
            { sessionID: sid, runtimeID, requestID: "resume", kind: "resume", payload: {} },
            Effect.gen(function* () {
              const entry = yield* SessionRequests.Current
              yield* runs.startOwned(sid, "main", Effect.succeed(output(sid)), Effect.never.pipe(
                Effect.ensuring(Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(gate)))),
              ))
              yield* Deferred.succeed(ready, entry!)
              if (waiter === "interrupted") yield* Effect.never
            }),
          )
          const entry = yield* Deferred.await(ready)
          if (waiter === "returned") {
            yield* Effect.gen(function* () {
              while (entry.fiber) yield* Effect.sleep("1 millis")
            }).pipe(Effect.timeout("3 seconds"))
          }
          yield* requests.submit({ sessionID: sid, runtimeID, requestID: "pending", kind: "send", payload: {} }, Effect.never)
          const cancelRequests = yield* requests.capture(sid)
          const cancelRunner = yield* runs.captureCancel(sid)
          const cancelling = yield* cancelRunner.pipe(Effect.forkChild)
          yield* Deferred.await(finalizing).pipe(Effect.timeout("3 seconds"))
          if (waiter === "interrupted") {
            yield* Fiber.interrupt(entry.fiber!)
            yield* Effect.gen(function* () {
              while (entry.fiber) yield* Effect.sleep("1 millis")
            }).pipe(Effect.timeout("3 seconds"))
          }
          yield* cancelRequests
          expect((yield* wait(requests, sid, "pending")).status).toBe("cancelled")
          expect((yield* requests.get(sid, "resume")).status).toBe("handed-off")
          expect(Exit.isFailure(yield* runs.assertNotBusy(sid).pipe(Effect.exit))).toBe(true)
          expect(events.filter((event) => ["completed", "failed", "cancelled"].includes(event.status))).toEqual([])
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(cancelling)
          expect((yield* wait(requests, sid, "resume")).status).toBe("cancelled")
          yield* cancelRequests
          yield* Effect.gen(function* () {
            while (!events.some((event) => ["completed", "failed", "cancelled"].includes(event.status)))
              yield* Effect.sleep("1 millis")
          }).pipe(Effect.timeout("3 seconds"))
          expect(events.filter((event) => ["completed", "failed", "cancelled"].includes(event.status))).toHaveLength(1)
          yield* runs.assertNotBusy(sid)
        }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
      }),
    ),
  )
}

// [TP-RUN-R13-06] cancellation before handoff still owns the preparation/submission boundary.
it.live("cancelled preparation cannot launch submission work later", () =>
  provideTmpdirInstance(() => Effect.gen(function* () {
    const requests = yield* SessionRequests.Service
    const { runtimeID } = yield* requests.list(sid)
    const gate = yield* Deferred.make<void>()
    const preparing = yield* Deferred.make<void>()
    let calls = 0
    const work = Effect.sync(() => { calls++ })
    yield* Effect.gen(function* () {
      const submitting = yield* requests.submit(
        { sessionID: sid, runtimeID, requestID: "preparing", kind: "send", payload: {} },
        work,
        Effect.gen(function* () {
          yield* Deferred.succeed(preparing, undefined)
          yield* Deferred.await(gate)
          return work
        }),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(preparing).pipe(Effect.timeout("3 seconds"))
      const cancel = yield* requests.capture(sid)
      yield* cancel
      expect((yield* requests.get(sid, "preparing")).status).toBe("cancelled")
      yield* Deferred.succeed(gate, undefined)
      expect((yield* Fiber.join(submitting)).status).toBe("cancelled")
      expect(calls).toBe(0)
    }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
  })),
)

// [TP-RUN-R13-06] every associated execution owns part of the request's lifetime.
for (const firstStatus of ["completed", "cancelled", "failed"] as const) {
  for (const secondStatus of ["completed", "cancelled", "failed"] as const) {
    it.live(`multiple executions wait for all exits: ${firstStatus} then ${secondStatus}`, () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const requests = yield* SessionRequests.Service
          const { runtimeID } = yield* requests.list(sid)
          const gate = yield* Deferred.make<void>()
          const observed = yield* Deferred.make<SessionRequests.Info>()
          yield* Effect.gen(function* () {
            yield* requests.submit(
              { sessionID: sid, runtimeID, requestID: "multiple", kind: "resume", payload: {} },
              Effect.gen(function* () {
                const first = yield* requests.start(sid, "main")
                const second = yield* requests.start(sid, "main")
                yield* requests.finish(first, firstStatus === "completed" ? Exit.succeed(undefined)
                  : firstStatus === "cancelled" ? Exit.failCause(Cause.interrupt()) : Exit.fail(new Error("failed execution")))
                yield* Deferred.succeed(observed, yield* requests.get(sid, "multiple"))
                yield* Deferred.await(gate)
                yield* requests.finish(second, secondStatus === "completed" ? Exit.succeed(undefined)
                  : secondStatus === "cancelled" ? Exit.failCause(Cause.interrupt()) : Exit.fail(new Error("failed execution")))
              }),
            )
            const waiting = yield* Deferred.await(observed).pipe(Effect.timeout("3 seconds"))
            expect(waiting.executionRefs).toHaveLength(2)
            expect(waiting.status).toBe("handed-off")
            yield* Deferred.succeed(gate, undefined)
            const final = yield* wait(requests, sid, "multiple")
            expect(final.status).toBe([firstStatus, secondStatus].includes("failed") ? "failed"
              : [firstStatus, secondStatus].includes("cancelled") ? "cancelled" : "completed")
          }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
        }),
      ),
    )
  }
}

// [TP-RUN-R13-02][TP-RUN-R13-06] Cancellation sees real Exit even when main's onInterrupt returns an old success.
it.live("owned cancellation settles no-message resume and cannot stop its successor", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const requests = yield* SessionRequests.Service
      const runs = yield* SessionRunState.Service
      const sid = (yield* (yield* Session.Service).create({ title: "request execution" })).id
      const { runtimeID } = yield* requests.list(sid)
      const started = yield* Deferred.make<void>()
      yield* requests.submit(
        { sessionID: sid, runtimeID, requestID: "resume", kind: "resume", payload: { userMessageID: "user" } },
        runs.startOwned(
          sid,
          "main",
          Effect.succeed(output(sid)),
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }),
        ),
      )
      yield* Deferred.await(started)
      const cancel = yield* runs.captureCancel(sid)
      yield* cancel
      const final = yield* wait(requests, sid, "resume")
      expect(final.status).toBe("cancelled")
      expect(final.assistantMessageIDs).toBeUndefined()
      const next = yield* runs.startOwned(sid, "main", Effect.succeed(output(sid)), Effect.never)
      yield* cancel
      expect(Exit.isFailure(yield* runs.assertNotBusy(sid).pipe(Effect.exit))).toBe(true)
      expect(yield* requests.get(sid, "resume")).toEqual(final)
      yield* next.interruptOwned
    }),
  ),
)

// [TP-RUN-R13-02][TP-RUN-R13-06]
it.live("Stop snapshot includes commands before Runner acquisition but excludes new requests", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const requests = yield* SessionRequests.Service
      const { runtimeID } = yield* requests.list(sid)
      yield* requests.submit({ sessionID: sid, runtimeID, requestID: "old", kind: "send", payload: {} }, Effect.never)
      const stop = yield* requests.capture(sid)
      yield* requests.submit({ sessionID: sid, runtimeID, requestID: "new", kind: "send", payload: {} }, Effect.never)
      yield* stop
      expect((yield* wait(requests, sid, "old")).status).toBe("cancelled")
      yield* stop
      expect((yield* requests.get(sid, "new")).status).toBe("accepted")
      yield* yield* requests.capture(sid)
    }),
  ),
)

// [TP-RUN-R13-02] An Effect success containing a failed assistant is not a successful execution.
it.live("failed assistant returns failed receipt rather than completed", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const requests = yield* SessionRequests.Service
      const runs = yield* SessionRunState.Service
      const sid = (yield* (yield* Session.Service).create({ title: "request execution" })).id
      const { runtimeID } = yield* requests.list(sid)
      const result = output(sid)
      if (result.info.role === "assistant")
        result.info.error = new MessageV2.APIError({
          message: "SYNTHETIC_PRIVATE_RUNNER_DETAIL",
          isRetryable: false,
          statusCode: 401,
          responseBody: "SYNTHETIC_PRIVATE_RUNNER_DETAIL",
          metadata: { secret: "SYNTHETIC_PRIVATE_RUNNER_DETAIL" },
        }).toObject()
      yield* requests.submit(
        { sessionID: sid, runtimeID, requestID: "failure", kind: "resume", payload: {} },
        runs.startOwned(sid, "main", Effect.succeed(output(sid)), Effect.succeed(result)),
      )
      const final = yield* wait(requests, sid, "failure")
      expect(final.status).toBe("failed")
      expect(final.executionRefs).toHaveLength(1)
      expect(final.error).toEqual({
        name: "APIError",
        data: { message: "Authentication failed. Invalid API Key.", statusCode: 401, isRetryable: false },
      })
      expect(JSON.stringify(final)).not.toContain("SYNTHETIC_PRIVATE_RUNNER_DETAIL")
    }),
  ),
)

// [TP-RUN-R13-02][TP-RUN-R13-03][TP-RUN-R13-06]
for (const mode of ["unconsumed", "cancelled"] as const) {
  it.live(`queued input is ${mode} rather than completed by another input's result`, () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const requests = yield* SessionRequests.Service
        const runs = yield* SessionRunState.Service
        const sid = (yield* (yield* Session.Service).create({ title: "queued request" })).id
        const { runtimeID } = yield* requests.list(sid)
        const gate = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const attached = yield* Deferred.make<void>()
        const old = output(sid)
        yield* runs.start(
          sid,
          "main",
          Effect.succeed(old),
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
            return old
          }),
        )
        yield* Deferred.await(started)
        yield* requests.submit(
          { sessionID: sid, runtimeID, requestID: "queued", kind: "steer", payload: {} },
          Effect.gen(function* () {
            yield* requests.user(sid, MessageID.ascending())
            yield* Deferred.succeed(attached, undefined)
            return yield* runs.ensureRunning(sid, "main", Effect.succeed(old), Effect.succeed(old))
          }),
        )
        yield* Deferred.await(attached)
        yield* Effect.sleep("10 millis")
        expect((yield* requests.get(sid, "queued")).executionRefs).toEqual([])
        if (mode === "cancelled") yield* yield* runs.captureCancel(sid)
        else yield* Deferred.succeed(gate, undefined)
        const final = yield* wait(requests, sid, "queued")
        expect(final.status).toBe(mode === "cancelled" ? "cancelled" : "failed")
        expect(final.assistantMessageIDs).toBeUndefined()
        expect(final.executionRefs).toEqual([])
        if (mode === "unconsumed") expect(final.error?.name).toBe("RequestNotConsumed")
      }),
    ),
  )
}

// [TP-RUN-R13-02] Runner failure before assistant persistence still has a terminal receipt.
it.live("failure after execution allocation without assistant converges", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const requests = yield* SessionRequests.Service
      const runs = yield* SessionRunState.Service
      const sid = (yield* (yield* Session.Service).create({ title: "no assistant failure" })).id
      const { runtimeID } = yield* requests.list(sid)
      yield* requests.submit(
        { sessionID: sid, runtimeID, requestID: "failure", kind: "resume", payload: {} },
        runs.startOwned(sid, "main", Effect.succeed(output(sid)), Effect.die(new Error("failed before assistant"))),
      )
      const final = yield* wait(requests, sid, "failure")
      expect(final.status).toBe("failed")
      expect(final.executionRefs).toHaveLength(1)
      expect(final.assistantMessageIDs).toBeUndefined()
      expect(final.error).toEqual({ name: "UnknownError", data: { message: "Request failed." } })
    }),
  ),
)

// [TP-RUN-R13-06] Stop freezes once during admission, not in its asynchronously scheduled work.
it.live("prepared abort captures before acknowledgement and only on first submission", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const requests = yield* SessionRequests.Service
      const { runtimeID } = yield* requests.list(sid)
      const gate = yield* Deferred.make<void>()
      const input = { sessionID: sid, runtimeID, requestID: "stop", kind: "abort" as const, payload: {} }
      yield* requests.submit({ ...input, requestID: "old", kind: "send" }, Effect.never)
      let captures = 0
      const prepare = Effect.gen(function* () {
        captures++
        const cancel = yield* requests.capture(sid)
        return Deferred.await(gate).pipe(Effect.andThen(cancel))
      })
      yield* requests.submit(input, Effect.void, prepare)
      expect(captures).toBe(1)
      yield* requests.submit({ ...input, requestID: "new", kind: "send" }, Effect.never)
      yield* requests.submit(input, Effect.void, prepare)
      expect(captures).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      expect((yield* wait(requests, sid, "stop")).status).toBe("completed")
      expect((yield* wait(requests, sid, "old")).status).toBe("cancelled")
      expect((yield* requests.get(sid, "new")).status).toBe("accepted")
      yield* yield* requests.capture(sid)
    }),
  ),
)

// [TP-RUN-R13-04][TP-RUN-R13-07] Instance identity changes; an absent record is not a success and is never replayed.
it.live("request scopes isolate directories and reject old incarnation after dispose", () =>
  Effect.gen(function* () {
    const requests = yield* SessionRequests.Service
    const first = yield* tmpdirScoped(),
      second = yield* tmpdirScoped()
    const old = yield* provideInstance(first)(
      Effect.gen(function* () {
        const { runtimeID } = yield* requests.list(sid)
        yield* requests.submit(
          { sessionID: sid, runtimeID, requestID: "same", kind: "command", payload: {} },
          Effect.void,
        )
        yield* wait(requests, sid, "same")
        return runtimeID
      }),
    )
    const other = yield* provideInstance(second)(requests.list(sid))
    expect(other.runtimeID).not.toBe(old)
    expect(other.requests).toEqual([])
    yield* Effect.promise(() => Instance.provide({ directory: first, fn: () => Instance.dispose() }))
    yield* provideInstance(first)(
      Effect.gen(function* () {
        const current = yield* requests.list(sid)
        expect(current.runtimeID).not.toBe(old)
        expect(current.requests).toEqual([])
        const stale = yield* requests
          .submit(
            { sessionID: sid, runtimeID: old, requestID: "same", kind: "abort", payload: {} },
            Effect.die("must not execute"),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(stale) && Cause.squash(stale.cause)).toMatchObject({ status: 410 })
        const missing = yield* requests.get(sid, "same", current.runtimeID).pipe(Effect.exit)
        expect(Exit.isFailure(missing) && Cause.squash(missing.cause)).toMatchObject({ status: 404 })
      }),
    )
    yield* Effect.promise(() => Instance.provide({ directory: first, fn: () => Instance.dispose() }))
    yield* Effect.promise(() => Instance.provide({ directory: second, fn: () => Instance.dispose() }))
  }),
)
