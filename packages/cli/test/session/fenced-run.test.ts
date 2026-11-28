// A run whose claimed inputs were cancelled out from under it (a stop fence, or
// boot reconciliation from another controller) can no longer claim lane input,
// yet a waiting input still supersedes its retries. Each superseded step starts
// another failing step at once, so the run must stop instead of spinning.
import path from "path"
import { afterEach, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, type Scope } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { inboxControllerRef, inboxServiceRef, InboxTable } from "../../src/inbox"
import { Actor } from "../../src/actor/spawn"
import { AppLayer } from "../../src/effect/app-runtime"
import { attach } from "../../src/effect/run-service"
import { Database, eq } from "../../src/storage"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer } from "../lib/scripted-llm-server"

afterEach(async () => {
  await Instance.disposeAll()
})

type AppServices = Layer.Success<typeof AppLayer>

const runApp = <A, E>(effect: Effect.Effect<A, E, AppServices | Scope.Scope>) =>
  Effect.runPromise(attach(effect).pipe(Effect.scoped, Effect.provide(AppLayer)))

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

// Every retry waits a minute, so any burst of requests comes from superseded steps.
function writeSlowRetryConfig(dir: string, origin: string) {
  const slow = { initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 }
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } } },
      agent: {
        build: { model: "alibaba/qwen-plus" },
        custom: { model: "alibaba/qwen-plus", mode: "subagent", completionGate: false },
      },
      retry: {
        request: { ...slow, mode: "bounded", maxRetries: 5, noDeadline: true },
        network: slow,
        server: slow,
        rateLimit: slow,
        stream: slow,
        unknown: slow,
      },
    }),
  )
}

function waitFor(condition: () => boolean) {
  return Effect.promise(async () => {
    while (!condition()) await Bun.sleep(10)
  }).pipe(Effect.timeout("10 seconds"))
}

test("a run whose claimed input was cancelled stops instead of spinning on superseded retries", async () => {
  await using tmp = await tmpdir({ git: true })
  const unavailable = [
    JSON.stringify({
      error: { code: "model_not_found", type: "new_api_error", message: "No available channel for model test/model" },
    }),
  ]
  // The last scripted response repeats, so every request fails with a retryable 503.
  const stub = startScriptedLLMServer([{ lines: unavailable, status: 503 }])
  try {
    await writeSlowRetryConfig(tmp.path, stub.origin)
    const result = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const controller = inboxControllerRef.current
            if (!controller) throw new Error("inbox controller is not bound")
            const session = yield* sessions.create({ title: "fenced-run" })
            const first = yield* prompt
              .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "First question." }] })
              .pipe(Effect.exit, Effect.forkChild)
            // The first request failed and the run is waiting out its one-minute retry.
            yield* waitFor(() => stub.captures.length >= 1)
            yield* Effect.sleep("200 millis")
            // Fence the run: its claimed input is cancelled while the run itself keeps going.
            yield* controller.withStop(session.id, Effect.void)
            const fenced = Database.use((db) =>
              db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, session.id)).all(),
            )
            const second = yield* prompt
              .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "Second question." }] })
              .pipe(Effect.exit, Effect.forkChild)
            // The fenced run ends and the second input's fresh run sends its request; a
            // spinning run never ends. Then confirm no further requests follow.
            const served = () =>
              stub.captures.filter((capture) => JSON.stringify(capture.messages).includes("Second question.")).length
            yield* waitFor(() => first.pollUnsafe() !== undefined && served() >= 1).pipe(Effect.ignore)
            const firstDone = first.pollUnsafe() !== undefined
            yield* Effect.sleep("500 millis")
            const requests = stub.captures.length
            const secondRequests = served()
            yield* prompt.cancel(session.id)
            yield* Fiber.join(first).pipe(Effect.timeout("10 seconds"))
            yield* Fiber.join(second).pipe(Effect.timeout("10 seconds"))
            return { fenced: fenced.map((row) => row.state), requests, secondRequests, firstDone }
          }),
        ),
    })
    expect(result.fenced).toEqual(["cancelled"])
    // The fenced run ended, and the second input started a fresh run that sent one
    // request and now waits out its own retry. Background requests such as title
    // generation may add one or two, but not a burst.
    expect(result.firstDone).toBe(true)
    expect(result.secondRequests).toBe(1)
    expect(result.requests).toBeLessThanOrEqual(4)
  } finally {
    await stub.stop()
  }
}, 30_000)

test("a subagent run fenced by a stop ends with a cancelled outcome instead of spinning", async () => {
  await using tmp = await tmpdir({ git: true })
  const unavailable = [
    JSON.stringify({
      error: { code: "model_not_found", type: "new_api_error", message: "No available channel for model test/model" },
    }),
  ]
  const stub = startScriptedLLMServer([{ lines: unavailable, status: 503 }])
  try {
    await writeSlowRetryConfig(tmp.path, stub.origin)
    const result = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        runApp(
          Effect.gen(function* () {
            const actors = yield* Actor.Service
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const controller = inboxControllerRef.current
            const inbox = inboxServiceRef.current
            if (!controller || !inbox) throw new Error("inbox services are not bound")
            const parent = yield* sessions.create({ title: "fenced-subagent" })
            const child = yield* actors.spawn({
              mode: "subagent",
              sessionID: parent.id,
              agentType: "custom",
              task: "Explore the module.",
              context: "none",
              tools: [],
              background: true,
            })
            // The child's first request failed and it is waiting out its one-minute retry.
            yield* waitFor(() => stub.captures.length >= 1)
            yield* Effect.sleep("200 millis")
            yield* controller.withStop(parent.id, Effect.void)
            // A follow-up waits in the child's lane and would supersede its retries.
            yield* inbox.accept({ receiverSessionID: parent.id, receiverActorID: child.actorID, content: "Follow-up." })
            const outcome = yield* Deferred.await(child.outcome).pipe(Effect.timeout("10 seconds"), Effect.option)
            yield* Effect.sleep("500 millis")
            const requests = stub.captures.length
            yield* prompt.cancel(parent.id)
            return { outcome, requests }
          }),
        ),
    })
    expect(result.outcome._tag).toBe("Some")
    if (result.outcome._tag === "Some") expect(result.outcome.value.status).toBe("cancelled")
    expect(result.requests).toBeLessThanOrEqual(4)
  } finally {
    await stub.stop()
  }
}, 30_000)
