import { afterEach, test, expect } from "bun:test"
import { getEventListeners } from "node:events"
import { Effect, Exit, Fiber, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Question } from "../../src/question"
import { Instance } from "../../src/project/instance"
import { QuestionID } from "../../src/question/schema"
import { tmpdir } from "../fixture/fixture"
import { MessageID, SessionID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"

const ask = (input: { sessionID: SessionID; questions: ReadonlyArray<Question.Info>; tool?: Question.Tool }) =>
  AppRuntime.runPromise(Question.Service.use((svc) => svc.ask(input)))

const list = () => AppRuntime.runPromise(Question.Service.use((svc) => svc.list()))

const reply = (input: { requestID: QuestionID; answers: ReadonlyArray<Question.Answer> }) =>
  AppRuntime.runPromise(Question.Service.use((svc) => svc.reply(input)))

const reject = (id: QuestionID) => AppRuntime.runPromise(Question.Service.use((svc) => svc.reject(id)))

afterEach(async () => {
  await Instance.disposeAll()
})

/** Reject all pending questions so dangling Deferred fibers don't hang the test. */
async function rejectAll() {
  const pending = await list()
  for (const req of pending) {
    await reject(req.id)
  }
}

test("ask - returns pending promise", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })
      expect(promise).toBeInstanceOf(Promise)
      await rejectAll()
      await promise.catch(() => {})
    },
  })
})

test("ask - adds to pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions,
      })

      const pending = await list()
      expect(pending.length).toBe(1)
      expect(pending[0].questions).toEqual(questions)
      await rejectAll()
      await promise.catch(() => {})
    },
  })
})

// reply tests

test("reply - resolves the pending ask with answers", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions,
      })

      const pending = await list()
      const requestID = pending[0].id

      await reply({
        requestID,
        answers: [["Option 1"]],
      })

      const answers = await promise
      expect(answers).toEqual([["Option 1"]])
    },
  })
})

test("reply - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await list()
      expect(pending.length).toBe(1)

      await reply({
        requestID: pending[0].id,
        answers: [["Option 1"]],
      })
      await promise

      const after = await list()
      expect(after.length).toBe(0)
    },
  })
})

test("reply - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await reply({
        requestID: QuestionID.make("que_unknown"),
        answers: [["Option 1"]],
      })
      // Should not throw
    },
  })
})

// reject tests

test("reject - throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await list()
      await reject(pending[0].id)

      await expect(promise).rejects.toBeInstanceOf(Question.RejectedError)
    },
  })
})

test("reject - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await list()
      expect(pending.length).toBe(1)

      await reject(pending[0].id)
      promise.catch(() => {}) // Ignore rejection

      const after = await list()
      expect(after.length).toBe(0)
    },
  })
})

test("reject - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await reject(QuestionID.make("que_unknown"))
      // Should not throw
    },
  })
})

// multiple questions tests

test("ask - handles multiple questions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Build", description: "Build the project" },
            { label: "Test", description: "Run tests" },
          ],
        },
        {
          question: "Which environment?",
          header: "Env",
          options: [
            { label: "Dev", description: "Development" },
            { label: "Prod", description: "Production" },
          ],
        },
      ]

      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions,
      })

      const pending = await list()

      await reply({
        requestID: pending[0].id,
        answers: [["Build"], ["Dev"]],
      })

      const answers = await promise
      expect(answers).toEqual([["Build"], ["Dev"]])
    },
  })
})

// list tests

test("list - returns all pending requests", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const p1 = ask({
        sessionID: SessionID.make("ses_test1"),
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }],
          },
        ],
      })

      const p2 = ask({
        sessionID: SessionID.make("ses_test2"),
        questions: [
          {
            question: "Question 2?",
            header: "Q2",
            options: [{ label: "B", description: "B" }],
          },
        ],
      })

      const pending = await list()
      expect(pending.length).toBe(2)
      await rejectAll()
      p1.catch(() => {})
      p2.catch(() => {})
    },
  })
})

test("list - returns empty when no pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = await list()
      expect(pending.length).toBe(0)
    },
  })
})

test("questions stay isolated by directory", async () => {
  await using one = await tmpdir({ git: true })
  await using two = await tmpdir({ git: true })

  const p1 = Instance.provide({
    directory: one.path,
    fn: () =>
      ask({
        sessionID: SessionID.make("ses_one"),
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }],
          },
        ],
      }),
  })

  const p2 = Instance.provide({
    directory: two.path,
    fn: () =>
      ask({
        sessionID: SessionID.make("ses_two"),
        questions: [
          {
            question: "Question 2?",
            header: "Q2",
            options: [{ label: "B", description: "B" }],
          },
        ],
      }),
  })

  const onePending = await Instance.provide({
    directory: one.path,
    fn: () => list(),
  })
  const twoPending = await Instance.provide({
    directory: two.path,
    fn: () => list(),
  })

  expect(onePending.length).toBe(1)
  expect(twoPending.length).toBe(1)
  expect(onePending[0].sessionID).toBe(SessionID.make("ses_one"))
  expect(twoPending[0].sessionID).toBe(SessionID.make("ses_two"))

  await Instance.provide({
    directory: one.path,
    fn: () => reject(onePending[0].id),
  })
  await Instance.provide({
    directory: two.path,
    fn: () => reject(twoPending[0].id),
  })

  await p1.catch(() => {})
  await p2.catch(() => {})
})

test("pending question survives deferred instance dispose", async () => {
  await using tmp = await tmpdir({ git: true })

  const pending = Instance.provide({
    directory: tmp.path,
    fn: () => {
      return ask({
        sessionID: SessionID.make("ses_dispose"),
        questions: [
          {
            question: "Dispose me?",
            header: "Dispose",
            options: [{ label: "Yes", description: "Yes" }],
          },
        ],
      })
    },
  })
  const result = pending.then(
    () => "resolved" as const,
    (err) => err,
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const items = await list()
      expect(items).toHaveLength(1)
      await Instance.dispose()
      expect(Instance.refreshStatus(tmp.path).state).toBe("pending")
      expect(await list()).toHaveLength(1)
      await reject(items[0]!.id)
    },
  })

  expect(await result).toBeInstanceOf(Question.RejectedError)
})

test("pending question prevents instance reload", async () => {
  await using tmp = await tmpdir({ git: true })

  const pending = Instance.provide({
    directory: tmp.path,
    fn: () => {
      return ask({
        sessionID: SessionID.make("ses_reload"),
        questions: [
          {
            question: "Reload me?",
            header: "Reload",
            options: [{ label: "Yes", description: "Yes" }],
          },
        ],
      })
    },
  })
  const result = pending.then(
    () => "resolved" as const,
    (err) => err,
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const items = await list()
      expect(items).toHaveLength(1)
      await expect(Instance.reload({ directory: tmp.path })).rejects.toThrow("Instance busy")
      expect(await list()).toHaveLength(1)
      await reject(items[0]!.id)
    },
  })

  expect(await result).toBeInstanceOf(Question.RejectedError)
})

const it = testEffect(Layer.mergeAll(Question.defaultLayer, CrossSpawnSpawner.defaultLayer))
const cancellationInput = {
  sessionID: SessionID.make("ses_cancel"),
  questions: [{ question: "Continue?", header: "Continue", options: [] }],
}

const waitForListener = Effect.fn("QuestionTest.waitForListener")(function* (signal: AbortSignal) {
  while (getEventListeners(signal, "abort").length === 0) yield* Effect.sleep("1 millis")
})

for (const when of ["before-ask", "during-asked"] as const) {
  it.live(`pre-aborted and publication-window cancellation: ${when} [TP-SR-R21-25]`, () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const controller = new AbortController()
        const events: string[] = []
        const listener = (event: GlobalEvent) => {
          if (event.directory !== directory || !event.payload.type.startsWith("question.")) return
          events.push(event.payload.type)
          if (event.payload.type === "question.asked") controller.abort()
        }
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
        if (when === "before-ask") controller.abort()
        const exit = yield* question.ask({ ...cancellationInput, abortSignal: controller.signal }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.stringify(exit)).toContain("QuestionRejectedError")
        expect(yield* question.list()).toEqual([])
        expect(events).toEqual(when === "before-ask" ? [] : ["question.asked", "question.rejected"])
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      }).pipe(Effect.timeout("5 seconds")),
    ),
  )
}

for (const outcome of ["abort", "reply", "reject", "reply-race", "reject-race", "interrupt"] as const) {
  it.live(`question cancellation ownership and listener cleanup: ${outcome} [TP-SR-R21-25]`, () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const controller = new AbortController()
        const events: string[] = []
        const listener = (event: GlobalEvent) => {
          if (event.directory !== directory || !event.payload.type.startsWith("question.")) return
          events.push(event.payload.type)
          // Exercise late abort before reply/reject has finished resolving its Deferred.
          if (outcome.endsWith("-race") && event.payload.type !== "question.asked") controller.abort()
        }
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
        const fiber = yield* question
          .ask({ ...cancellationInput, abortSignal: controller.signal })
          .pipe(Effect.forkScoped)
        yield* waitForListener(controller.signal)
        const [request] = yield* question.list()
        expect(request).toBeDefined()
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
        if (outcome === "abort") controller.abort()
        if (outcome.startsWith("reply")) yield* question.reply({ requestID: request.id, answers: [["Yes"]] })
        if (outcome.startsWith("reject")) yield* question.reject(request.id)
        if (outcome === "interrupt") yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(outcome.startsWith("reply"))
        if (Exit.isSuccess(exit)) expect(exit.value).toEqual([["Yes"]])
        if (outcome === "abort" || outcome.startsWith("reject")) expect(JSON.stringify(exit)).toContain("QuestionRejectedError")
        expect(yield* question.list()).toEqual([])
        expect(events).toEqual(["question.asked", outcome.startsWith("reply") ? "question.replied" : "question.rejected"])
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        controller.abort()
        expect(events).toHaveLength(2)
      }).pipe(Effect.timeout("5 seconds")),
    ),
  )
}

it.live("aborting one question preserves same-session and cross-session requests [TP-SR-R21-25]", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const controllers = [new AbortController(), new AbortController(), new AbortController()]
      const fibers = yield* Effect.forEach(controllers, (controller, index) =>
        question
          .ask({
            ...cancellationInput,
            sessionID: index === 2 ? SessionID.make("ses_other") : cancellationInput.sessionID,
            tool: { messageID: MessageID.make(`msg_question_${index}`), callID: `question-${index}` },
            abortSignal: controller.signal,
          })
          .pipe(Effect.forkScoped),
      )
      yield* Effect.forEach(controllers, (controller) => waitForListener(controller.signal))
      const requests = yield* question.list()
      expect(requests).toHaveLength(3)
      controllers[0].abort()
      expect(Exit.isFailure(yield* Fiber.await(fibers[0]))).toBe(true)
      const remaining = yield* question.list()
      expect(remaining.map((request) => request.tool?.callID)).toEqual(["question-1", "question-2"])
      yield* Effect.forEach(remaining, (request) => question.reply({ requestID: request.id, answers: [["Yes"]] }))
      expect(yield* Fiber.join(fibers[1])).toEqual([["Yes"]])
      expect(yield* Fiber.join(fibers[2])).toEqual([["Yes"]])
      expect(yield* question.list()).toEqual([])
      for (const controller of controllers) expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    }).pipe(Effect.timeout("5 seconds")),
  ),
)
