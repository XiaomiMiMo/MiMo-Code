import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { AppLayer } from "../../src/effect/app-runtime"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Instance, type InstanceContext } from "../../src/project/instance"
import { InboxTable } from "../../src/inbox"
import { inboxServiceRef } from "../../src/inbox/inbox-ref"
import { schedulerRef } from "../../src/inbox/scheduler"
import { Database, eq } from "../../src/storage"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

const it = testEffect(AppLayer.pipe(Layer.provideMerge(CrossSpawnSpawner.defaultLayer)))
// Instance.provide would count the entire assertion body as a live request,
// concealing the last-execution handoff under test. Restore only its context.
const restoreInstance =
  (context: InstanceContext) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.contextWith((services: Context.Context<R>) =>
      Effect.promise<A>(() =>
        Instance.restore(context, () =>
          Effect.runPromiseWith(services)(self.pipe(Effect.provideService(InstanceRef, context))),
        ),
      ),
    )
const eventually = (predicate: () => boolean, message: string) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return
      await Bun.sleep(10)
    }
    throw new Error(message)
  })

const receiver = (held = true) =>
  Effect.gen(function* () {
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const server = startScriptedLLMServer([
      { lines: textStopResponse("INITIAL_DONE") },
      {
        lines: textStopResponse("WAKE_DONE"),
        beforeReply: async () => {
          entered.resolve()
          if (held) await finish.promise
        },
      },
    ])
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        finish.resolve()
        await server.stop()
      }),
    )
    const dir = yield* tmpdirScoped({
      git: true,
      config: {
        model: "test/model",
        provider: {
          test: {
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "fixture", baseURL: `${server.origin}/v1` },
            models: { model: { name: "Fixture model", tool_call: true, limit: { context: 128000, output: 4096 } } },
          },
        },
      },
    })
    const context = yield* Effect.promise(() => Instance.provide({ directory: dir, fn: () => Instance.current }))
    yield* Effect.addFinalizer(() => Effect.promise(() => Instance.disposeDirectory(dir)))
    const session = yield* Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "Wake ownership fixture" })
      yield* prompt.prompt({
        sessionID: session.id,
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("model") },
        parts: [{ type: "text", text: "Initial request" }],
      })
      yield* Effect.sleep("20 millis")
      return session
    }).pipe(restoreInstance(context))
    return { dir, context, session, entered, finish, server }
  })

for (const deliveries of [1, 2]) {
  it.live(
    `pending disposal keeps ${deliveries} inbox wake deliveries alive until the real receiver finishes`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* receiver()
        yield* Effect.gen(function* () {
          const inbox = inboxServiceRef.current
          if (!inbox) throw new Error("Inbox service was not initialized")
          const sessions = yield* Session.Service
          const releaseSender = Instance.claim(fixture.dir)
          yield* Effect.promise(() => Instance.disposeDirectory(fixture.dir))
          expect(Instance.refreshStatus(fixture.dir).state).toBe("pending")
          // Send and sender release share one continuation; no artificial sleep
          // lets the scheduled wake acquire its Runner before this boundary.
          yield* Effect.gen(function* () {
            for (let index = 0; index < deliveries; index++)
              yield* inbox.accept({
                receiverSessionID: fixture.session.id,
                receiverActorID: "main",
                type: "actor_notification",
                content: `Delivery ${index}: CHILD_DONE`,
              })
            yield* Effect.sync(releaseSender)
          }).pipe(Effect.uninterruptible)
          yield* Effect.promise(() => fixture.entered.promise).pipe(Effect.timeout("2 seconds"))
          expect(Instance.refreshStatus(fixture.dir).state).toBe("pending")
          expect(fixture.server.captures).toHaveLength(2)
          expect(JSON.stringify(fixture.server.captures[1].messages)).toContain("CHILD_DONE")
          fixture.finish.resolve()
          yield* eventually(
            () => Instance.refreshStatus(fixture.dir).state === "applied",
            "receiver exit did not release pending disposal",
          )
          const messages = yield* sessions.messages({ sessionID: fixture.session.id, agentID: "main" })
          expect(
            messages.filter((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "WAKE_DONE"),
            ),
          ).toHaveLength(1)
        }).pipe(restoreInstance(fixture.context))
      }),
    15_000,
  )
}

it.live(
  "quiet inbox delivery persists without waking or retaining a pending instance",
  () =>
    Effect.gen(function* () {
      const fixture = yield* receiver(false)
      yield* Effect.gen(function* () {
        const inbox = inboxServiceRef.current
        if (!inbox) throw new Error("Inbox service was not initialized")
        const releaseSender = Instance.claim(fixture.dir)
        yield* Effect.promise(() => Instance.disposeDirectory(fixture.dir))
        const prompt = yield* SessionPrompt.Service
        const result = yield* prompt.prompt({
          sessionID: fixture.session.id,
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("model") },
          parts: [{ type: "text", text: "QUIET_DELIVERY" }],
          noReply: true,
        })
        yield* Effect.sync(releaseSender)
        yield* eventually(
          () => Instance.refreshStatus(fixture.dir).state === "applied",
          "quiet delivery retained the instance",
        )
        const row = yield* Effect.sync(() =>
          Database.use((db) => db.select().from(InboxTable).where(eq(InboxTable.input_message_id, result.info.id)).get()),
        )
        expect(row).toBeUndefined()
        expect(result.parts.some(part => part.type === "text" && part.text === "QUIET_DELIVERY")).toBe(true)
        expect(fixture.server.captures).toHaveLength(1)
      }).pipe(restoreInstance(fixture.context))
    }),
  15_000,
)

it.live(
  "aborting the receiver releases its scheduled wake and does not restart it after disposal",
  () =>
    Effect.gen(function* () {
      const fixture = yield* receiver()
      yield* Effect.gen(function* () {
        const inbox = inboxServiceRef.current
        if (!inbox) throw new Error("Inbox service was not initialized")
        const state = yield* SessionRunState.Service
        const releaseSender = Instance.claim(fixture.dir)
        yield* Effect.promise(() => Instance.disposeDirectory(fixture.dir))
        yield* inbox.accept({ receiverSessionID: fixture.session.id, receiverActorID: "main", content: "ABORT_DELIVERY" })
        yield* Effect.sync(releaseSender)
        yield* Effect.promise(() => fixture.entered.promise).pipe(Effect.timeout("2 seconds"))
        yield* state.cancel(fixture.session.id)
        yield* eventually(
          () => Instance.refreshStatus(fixture.dir).state === "applied",
          "abort did not release wake ownership",
        )
        fixture.finish.resolve()
        yield* Effect.sleep("30 millis")
        expect(fixture.server.captures).toHaveLength(2)
      }).pipe(restoreInstance(fixture.context))
    }),
  15_000,
)

it.live(
  "a wake interrupted before its body releases the scheduling claim",
  () =>
    Effect.gen(function* () {
      const fixture = yield* receiver()
      const previous = schedulerRef.current
      // Existing runtime port: isolate the before-body interruption boundary,
      // while keeping real Inbox persistence and Instance disposal accounting.
      const interrupted = { kick: () => Effect.interrupt }
      schedulerRef.current = interrupted
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (schedulerRef.current === interrupted) schedulerRef.current = previous
        }),
      )
      yield* Effect.gen(function* () {
        const inbox = inboxServiceRef.current
        if (!inbox) throw new Error("Inbox service was not initialized")
        const releaseSender = Instance.claim(fixture.dir)
        yield* Effect.promise(() => Instance.disposeDirectory(fixture.dir))
        const result = yield* inbox.accept({
          receiverSessionID: fixture.session.id,
          receiverActorID: "main",
          content: "INTERRUPTED_WAKE",
        })
        releaseSender()
        yield* eventually(
          () => Instance.refreshStatus(fixture.dir).state === "applied",
          "interrupted wake leaked its scheduling claim",
        )
        const row = yield* Effect.sync(() =>
          Database.use((db) => db.select().from(InboxTable).where(eq(InboxTable.id, result.inboxID)).get()),
        )
        expect(row).toMatchObject({ state: "accepted", input_message_id: result.inputMessageID, content: null })
        expect(fixture.server.captures).toHaveLength(1)
      }).pipe(restoreInstance(fixture.context))
    }),
  15_000,
)

it.live(
  "abort immediately after send cannot let a queued wake restart the receiver",
  () =>
    Effect.gen(function* () {
      const fixture = yield* receiver()
      yield* Effect.gen(function* () {
        const inbox = inboxServiceRef.current
        if (!inbox) throw new Error("Inbox service was not initialized")
        const state = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        const releaseSender = Instance.claim(fixture.dir)
        yield* Effect.promise(() => Instance.disposeDirectory(fixture.dir))
        yield* inbox.accept({
          receiverSessionID: fixture.session.id,
          receiverActorID: "main",
          content: "IMMEDIATE_ABORT_DELIVERY",
        })
        yield* state.cancel(fixture.session.id)
        const requestsAtAbort = fixture.server.captures.length
        releaseSender()
        fixture.finish.resolve()
        yield* eventually(
          () => Instance.refreshStatus(fixture.dir).state === "applied",
          "immediate abort retained the instance",
        )
        yield* Effect.sleep("30 millis")
        expect(fixture.server.captures).toHaveLength(requestsAtAbort)
        const messages = yield* sessions.messages({ sessionID: fixture.session.id, agentID: "main" })
        expect(messages.some(message => message.parts.some(part => part.type === "text" && part.text === "WAKE_DONE"))).toBe(false)
      }).pipe(restoreInstance(fixture.context))
    }),
  15_000,
)
