import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { GlobalBus } from "../../src/bus/global"
import { Database, desc, eq } from "../../src/storage"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageTable, SessionTable } from "../../src/session/session.sql"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { spawnRef } from "../../src/actor/spawn-ref"
import type { AgentOutcome } from "../../src/actor/spawn"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("alibaba"),
  modelID: ModelID.make("qwen-plus"),
}

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

function chat(text: string, promptTokens?: number): ReadableStream<Uint8Array> {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage:
          promptTokens === undefined
            ? undefined
            : { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(payload))
      ctrl.close()
    },
  })
}

function startUsageLLM(replies: Array<{ text: string; promptTokens: number }>) {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const reply = replies[Math.min(calls, replies.length - 1)]!
      calls++
      return new Response(chat(reply.text, reply.promptTokens), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  return {
    origin: server.url.origin,
    get calls() {
      return calls
    },
    stop: () => server.stop(true),
  }
}

function startLLM(reply: string) {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      calls++
      return new Response(chat(reply), { status: 200, headers: { "Content-Type": "text/event-stream" } })
    },
  })
  return {
    origin: server.url.origin,
    get calls() {
      return calls
    },
    stop: () => server.stop(true),
  }
}

type SpawnImpl = NonNullable<typeof spawnRef.current>

function withSpawnRef<T>(impl: SpawnImpl | undefined, body: () => Promise<T>): Promise<T> {
  const prev = spawnRef.current
  spawnRef.current = impl
  return body().finally(() => {
    spawnRef.current = prev
  })
}

/**
 * Writer stub that behaves like a REAL writer: it does not finish instantly.
 * It resolves `delayMs` later, and only then writes real checkpoint content and
 * advances the watermark.
 *
 * The delay is load-bearing for what this file proves. prune.fireCheckpoints
 * runs immediately BEFORE the overflow check (prune.ts:289) and already calls
 * tryStartCheckpointWriter, which scaffolds an empty template file
 * (checkpoint.ts:650). So at the moment the overflow check runs, the realistic
 * state is: checkpoint FILE exists, watermark NOT yet set, writer in flight —
 * which is what rebuildFromCheckpoint reports as "nothing usable". An
 * instant-success stub would have already advanced the watermark by then, so the
 * old code would have rebuilt too and the test would prove nothing.
 */
function writerThatWritesCheckpointAfter(marker: string, delayMs: number, onSpawn?: () => void): SpawnImpl {
  let counter = 0
  return {
    spawn: (input) =>
      Effect.gen(function* () {
        counter += 1
        onSpawn?.()
        const parent = (input.parentSessionID ?? input.sessionID) as SessionID
        const outcome = yield* Deferred.make<AgentOutcome>()
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            yield* Effect.sleep(delayMs)
            const cpFile = checkpointPath(parent)
            yield* Effect.promise(() => fs.mkdir(path.dirname(cpFile), { recursive: true }))
            yield* Effect.promise(() =>
              fs.writeFile(cpFile, `# Session checkpoint\n\n## §1 Active intent\n${marker}\n`),
            )
            const last = yield* Effect.sync(() =>
              Database.use((db) =>
                db
                  .select({ id: MessageTable.id })
                  .from(MessageTable)
                  .where(eq(MessageTable.session_id, parent))
                  .orderBy(desc(MessageTable.id))
                  .limit(1)
                  .get(),
              ),
            )
            if (last?.id) {
              yield* Effect.sync(() =>
                Database.use((db) =>
                  db
                    .update(SessionTable)
                    .set({ last_checkpoint_message_id: last.id })
                    .where(eq(SessionTable.id, parent))
                    .run(),
                ),
              )
            }
            yield* Deferred.succeed(outcome, { status: "success" as const })
          }),
        )
        return { actorID: `${input.agentType}-${counter}`, sessionID: input.sessionID, outcome }
      }),
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(undefined),
  } as SpawnImpl
}

function writerThatFails(): SpawnImpl {
  let counter = 0
  return {
    spawn: (input) =>
      Effect.gen(function* () {
        counter += 1
        const outcome = yield* Deferred.make<AgentOutcome>()
        yield* Deferred.succeed(outcome, { status: "failure" as const, error: "writer blew up" })
        return { actorID: `${input.agentType}-${counter}`, sessionID: input.sessionID, outcome }
      }),
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(undefined),
  } as SpawnImpl
}

// Shrink the usable window so a seeded token count trips
// SessionOverflow.isOverflow deterministically. reserves() = compaction.reserved
// (100) + a 20_000 output reservation (this model publishes no limit.input), so
// max_context must exceed ~20_100 to be honoured at all. It must ALSO leave
// usable > 13_000, or SessionPrune.resolveThresholds refuses the window
// ("too small for checkpoints"). 40_000 satisfies both: usable = 40_000 -
// 20_100 = 19_900, against the seeded 50_000 tokens.
function mimocodeConfig(baseURL: string, maxContext = 40_000, checkpoint?: { thresholds: string[]; reserved: number }) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["alibaba"],
    provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${baseURL}/v1` } } },
    agent: { build: { model: "alibaba/qwen-plus" } },
    compaction: { reserved: 100, max_context: maxContext },
    checkpoint,
  })
}

async function seedUserMessage(sessionID: SessionID, text: string) {
  const msg = await Effect.runPromise(
    Session.Service.use((s) =>
      s.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        // F49+F50: the main agent's messages carry agentID "main", and the
        // runLoop reads its slice with agentID "main" — seeds must match or
        // they are invisible to the overflow check.
        agentID: "main",
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      }),
    ).pipe(Effect.provide(Session.defaultLayer)),
  )
  await Effect.runPromise(
    Session.Service.use((s) =>
      s.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text }),
    ).pipe(Effect.provide(Session.defaultLayer)),
  )
  return msg
}

/**
 * Seed a COMPLETED assistant turn reporting a token count far above the usable
 * window. The runLoop reads exactly this message as `lastFinished` and feeds its
 * tokens to the overflow check, so this is what makes the next prompt overflow.
 */
async function seedFinishedAssistant(sessionID: SessionID, parentID: MessageID, totalTokens: number) {
  const msg = await Effect.runPromise(
    Session.Service.use((s) =>
      s.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        parentID,
        agentID: "main",
        agent: "build",
        mode: "build",
        modelID: ref.modelID,
        providerID: ref.providerID,
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        finish: "stop",
        tokens: { total: totalTokens, input: totalTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now(), completed: Date.now() },
      }),
    ).pipe(Effect.provide(Session.defaultLayer)),
  )
  await Effect.runPromise(
    Session.Service.use((s) =>
      s.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text: "a very long prior answer",
      }),
    ).pipe(Effect.provide(Session.defaultLayer)),
  )
  return msg
}

// These tests drive the REAL main-agent context-overflow path inside
// SessionPrompt's runLoop (prompt.ts, the `overflowCheck(...)` branch) against
// a scripted LLM stub, and assert on
// what the session ends up containing: a `checkpoint` boundary part (rebuild) vs
// a `compaction` boundary part (degradation).
//
// The behaviour under test is the fix for the auto/manual asymmetry: both paths
// share rebuildFromCheckpoint, which only checks hasCheckpoint and returns
// false. Manual /rebuild handled `false` by writing a checkpoint on the spot and
// waiting; the auto path used to give up and call compaction.create. Now both go
// through rebuildEnsuringCheckpoint, and compaction is reachable from exactly
// ONE condition: no checkpoint AND the writer failed / never ran / the wait bound
// expired.
//
// Why this matters more than it looks: compaction.create is NOT an LLM
// summarizer (measured p50 0.240ms). It inserts a bare `compaction` marker that
// MessageV2.filterCompacted breaks at, so every pre-boundary message is dropped
// with no summary at all. Degrading is therefore a real loss, not a cheaper
// summary.
describe("Auto context overflow: write a checkpoint before degrading to compaction", () => {
  test(
    "a completed high-usage turn is rebuilt exactly once",
    async () => {
      const llm = startUsageLLM([
        { text: "initialized", promptTokens: 1_000 },
        { text: "high-usage reply", promptTokens: 25_000 },
        { text: "reply after rebuild", promptTokens: 1_000 },
      ])
      let writerCalls = 0
      const writer = writerThatWritesCheckpointAfter("HIGH_USAGE_CHECKPOINT", 400, () => writerCalls++)
      try {
        await using tmp = await tmpdir({
          git: true,
          init: (dir) => Bun.write(path.join(dir, "mimocode.json"), mimocodeConfig(llm.origin)),
        })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const prompt = yield* SessionPrompt.Service
                const sessions = yield* Session.Service
                const info = yield* sessions.create({ title: "high-usage-single-rebuild" })

                // The first prompt resolves the late-bound actor layer, which
                // installs its real spawn implementation.
                yield* prompt.prompt({
                  sessionID: info.id,
                  parts: [{ type: "text", text: "initialize the actor layer" }],
                  agent: "build",
                })

                // Bind the deterministic writer after layer initialization.
                const previous = spawnRef.current
                spawnRef.current = writer
                yield* prompt
                  .prompt({
                    sessionID: info.id,
                    parts: [{ type: "text", text: "produce one high-usage turn" }],
                    agent: "build",
                  })
                  .pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        spawnRef.current = previous
                      }),
                    ),
                  )

                yield* prompt.prompt({
                  sessionID: info.id,
                  parts: [{ type: "text", text: "continue after the automatic rebuild" }],
                  agent: "build",
                })

                const after = yield* sessions.messages({ sessionID: info.id })
                const checkpoints = after.filter((m) => m.parts.some((p) => p.type === "checkpoint"))
                expect(checkpoints).toHaveLength(1)
                expect(new Set(checkpoints.map((m) => m.info.id)).size).toBe(1)
                expect(writerCalls).toBe(1)
                expect(llm.calls).toBe(3)
                expect(
                  after.some((m) => m.parts.some((p) => p.type === "text" && p.text === "reply after rebuild")),
                ).toBe(true)
              }),
            ),
        })
      } finally {
        await llm.stop()
      }
    },
    { timeout: 60_000 },
  )

  test(
    "crossing the final checkpoint threshold below the configured context trigger does not rebuild",
    async () => {
      const llm = startLLM("reply-before-context-trigger")
      let writerCalls = 0
      const writer = writerThatWritesCheckpointAfter("CHECKPOINT_WITHOUT_REBUILD", 400, () => writerCalls++)
      try {
        await using tmp = await tmpdir({
          git: true,
          init: (dir) =>
            Bun.write(
              path.join(dir, "mimocode.json"),
              mimocodeConfig(llm.origin, 50_000, { thresholds: ["24K"], reserved: 100 }),
            ),
        })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const prompt = yield* SessionPrompt.Service
                const sessions = yield* Session.Service
                const info = yield* sessions.create({ title: "checkpoint-without-early-rebuild" })

                // Resolve SessionPrompt's actor layer before replacing the
                // late-bound writer implementation below.
                yield* prompt.prompt({
                  sessionID: info.id,
                  parts: [{ type: "text", text: "initialize the actor layer" }],
                  agent: "build",
                })

                // usable = 50K - 20.1K reserves = 29.9K. The single 24K
                // checkpoint threshold is below it, so 25K must write a
                // checkpoint without rebuilding before the 29.9K trigger.
                const first = yield* Effect.promise(() => seedUserMessage(info.id, "earlier question"))
                yield* Effect.promise(() => seedFinishedAssistant(info.id, first.id, 25_000))

                // SessionPrompt's layer initialization installs the real
                // actor implementation into spawnRef, so bind the writer
                // double after resolving the service and for this call only.
                const previous = spawnRef.current
                spawnRef.current = writer
                yield* prompt
                  .prompt({
                    sessionID: info.id,
                    parts: [{ type: "text", text: "continue below the configured trigger" }],
                    agent: "build",
                  })
                  .pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        spawnRef.current = previous
                      }),
                    ),
                  )
                yield* Effect.sleep(500)

                const after = yield* sessions.messages({ sessionID: info.id })
                expect(writerCalls).toBe(1)
                expect(yield* Effect.promise(() => Bun.file(checkpointPath(info.id)).text())).toContain(
                  "CHECKPOINT_WITHOUT_REBUILD",
                )
                const watermark = yield* Effect.sync(() =>
                  Database.use((db) =>
                    db
                      .select({ id: SessionTable.last_checkpoint_message_id })
                      .from(SessionTable)
                      .where(eq(SessionTable.id, info.id))
                      .get(),
                  ),
                )
                expect(watermark?.id).toBeTruthy()
                expect(after.some((m) => m.parts.some((p) => p.type === "checkpoint"))).toBe(false)
                expect(after.some((m) => m.parts.some((p) => p.type === "compaction"))).toBe(false)
                expect(
                  after.some((m) =>
                    m.parts.some((p) => p.type === "text" && p.text === "reply-before-context-trigger"),
                  ),
                ).toBe(true)
                expect(llm.calls).toBe(2)
              }),
            ),
        })
      } finally {
        await llm.stop()
      }
    },
    { timeout: 60_000 },
  )

  test(
    "no checkpoint + writer succeeds → inserts a checkpoint boundary and does NOT compact",
    async () => {
      const llm = startLLM("post-rebuild-reply")
      const writer = writerThatWritesCheckpointAfter("AUTO_OVERFLOW_FRESH_CHECKPOINT", 400)
      const seen: Array<string | undefined> = []
      const onEvent = (e: {
        payload?: { type?: string; properties?: { status?: { type?: string; message?: string } } }
      }) => {
        if (e?.payload?.type === "session.status" && e.payload.properties?.status?.type === "busy") {
          seen.push(e.payload.properties.status.message)
        }
      }
      GlobalBus.on("event", onEvent)
      try {
        await using tmp = await tmpdir({
          git: true,
          init: (dir) => Bun.write(path.join(dir, "mimocode.json"), mimocodeConfig(llm.origin)),
        })

        await withSpawnRef(writer, () =>
          Instance.provide({
            directory: tmp.path,
            fn: () =>
              run(
                Effect.gen(function* () {
                  const prompt = yield* SessionPrompt.Service
                  const sessions = yield* Session.Service
                  const info = yield* sessions.create({ title: "auto-overflow-rebuild" })

                  // Cold session (no checkpoint file) whose last completed
                  // assistant turn already blew the usable window.
                  const first = yield* Effect.promise(() => seedUserMessage(info.id, "earlier question"))
                  yield* Effect.promise(() => seedFinishedAssistant(info.id, first.id, 50_000))

                  yield* prompt.prompt({
                    sessionID: info.id,
                    parts: [{ type: "text", text: "next question that overflows" }],
                    agent: "build",
                  })

                  const after = yield* sessions.messages({ sessionID: info.id })

                  // The overflow was resolved by a REBUILD: a checkpoint
                  // boundary landed…
                  const checkpoints = after.filter((m) => m.parts.some((p) => p.type === "checkpoint"))
                  expect(checkpoints.length).toBe(1)
                  expect(checkpoints[0]!.info.role).toBe("user")

                  // …and NOT by degrading to compaction. This is the assertion
                  // that fails before the fix: the old code called
                  // compaction.create the moment rebuildFromCheckpoint said no.
                  const compactions = after.filter((m) => m.parts.some((p) => p.type === "compaction"))
                  expect(compactions.length).toBe(0)

                  // A writer actually settled: the checkpoint watermark is now
                  // set. Before the fix nothing waited for it, so at the moment
                  // the overflow check ran the watermark was still unset — which
                  // is exactly why rebuildFromCheckpoint returned false and the
                  // old code compacted.
                  const watermark = yield* Effect.sync(() =>
                    Database.use((db) =>
                      db
                        .select({ id: SessionTable.last_checkpoint_message_id })
                        .from(SessionTable)
                        .where(eq(SessionTable.id, info.id))
                        .get(),
                    ),
                  )
                  expect(watermark?.id).toBeTruthy()

                  // The boundary is the message the watermark points at or later
                  // — i.e. the rebuild used the checkpoint, not a guess.
                  expect(checkpoints[0]!.parts.some((p) => p.type === "checkpoint")).toBe(true)
                }),
              ),
          }),
        )
      } finally {
        GlobalBus.off("event", onEvent)
        await llm.stop()
      }

      // A multi-minute mid-turn wait must be explained, not look frozen.
      expect(seen).toContain("Writing checkpoint\u2026")
    },
    { timeout: 60_000 },
  )

  test(
    "no checkpoint + writer genuinely fails → STILL falls back to compaction",
    async () => {
      const llm = startLLM("post-compaction-reply")
      // Writer spawns and reports failure — the genuine-failure case, which is
      // the ONLY condition allowed to reach compaction.
      const writer = writerThatFails()
      try {
        await using tmp = await tmpdir({
          git: true,
          init: (dir) => Bun.write(path.join(dir, "mimocode.json"), mimocodeConfig(llm.origin)),
        })

        await withSpawnRef(writer, () =>
          Instance.provide({
            directory: tmp.path,
            fn: () =>
              run(
                Effect.gen(function* () {
                  const prompt = yield* SessionPrompt.Service
                  const sessions = yield* Session.Service
                  const info = yield* sessions.create({ title: "auto-overflow-compaction" })

                  const first = yield* Effect.promise(() => seedUserMessage(info.id, "earlier question"))
                  yield* Effect.promise(() => seedFinishedAssistant(info.id, first.id, 50_000))

                  yield* prompt.prompt({
                    sessionID: info.id,
                    parts: [{ type: "text", text: "next question that overflows" }],
                    agent: "build",
                  })

                  const after = yield* sessions.messages({ sessionID: info.id })

                  // Writer failed and no checkpoint existed → degrade.
                  const compactions = after.filter((m) => m.parts.some((p) => p.type === "compaction"))
                  expect(compactions.length).toBe(1)

                  // No checkpoint boundary, because no checkpoint was written.
                  const checkpoints = after.filter((m) => m.parts.some((p) => p.type === "checkpoint"))
                  expect(checkpoints.length).toBe(0)
                }),
              ),
          }),
        )
      } finally {
        await llm.stop()
      }
    },
    { timeout: 60_000 },
  )

  // The arrival state this guards is NORMAL, not degraded, which is what makes
  // it easy to misclassify. `prune.fireCheckpoints` (prune.ts:289) runs
  // immediately BEFORE the overflow check, and `tryStartCheckpointWriter`
  // scaffolds an EMPTY TEMPLATE (checkpoint.ts:650) *before* spawning the
  // writer. So by the time the overflow check runs, "checkpoint file on disk,
  // watermark not yet written" is the ordinary case.
  //
  // Two successive bugs lived here, and the second one hid inside the fix for
  // the first:
  //
  //  1. The discriminator keyed on bare `hasCheckpoint` — literally
  //     `Bun.file(...).exists()` (checkpoint.ts:1021) — so the scaffolded
  //     template counted as a usable checkpoint and the state was reported as
  //     `insert-failed`.
  //  2. Re-keying it on `lastBoundary` was right in substance but was written as
  //     `boundary !== undefined`, and `lastBoundary` returned JS `null` for an
  //     unset watermark (a nullable column behind an unchecked
  //     `as MessageID | undefined` cast, checkpoint.ts:1422). `null !== undefined`
  //     is true, so the new guard was a NO-OP and behaved exactly like (1).
  //
  // Both bugs present identically and silently: `insert-failed` is the one
  // outcome that neither rebuilds nor compacts (prompt.ts:3515-3521 deliberately
  // falls through to the model call), so the overflow is simply left unresolved
  // — zero checkpoints AND zero compactions, no error anywhere. That signature
  // is why this needs a test rather than a code reading: the sibling test above
  // passes with either bug in place, because it seeds no file at all.
  test(
    "a scaffolded-but-empty checkpoint file still starts and awaits the writer",
    async () => {
      const llm = startLLM("post-rebuild-reply")
      const writer = writerThatWritesCheckpointAfter("SCAFFOLD_THEN_REAL_CHECKPOINT", 400)
      try {
        await using tmp = await tmpdir({
          git: true,
          init: (dir) => Bun.write(path.join(dir, "mimocode.json"), mimocodeConfig(llm.origin)),
        })

        await withSpawnRef(writer, () =>
          Instance.provide({
            directory: tmp.path,
            fn: () =>
              run(
                Effect.gen(function* () {
                  const prompt = yield* SessionPrompt.Service
                  const sessions = yield* Session.Service
                  const info = yield* sessions.create({ title: "auto-overflow-scaffolded" })

                  const first = yield* Effect.promise(() => seedUserMessage(info.id, "earlier question"))
                  yield* Effect.promise(() => seedFinishedAssistant(info.id, first.id, 50_000))

                  // Exactly what tryStartCheckpointWriter leaves behind before
                  // the writer has produced anything: the file exists, the
                  // watermark does not.
                  const file = checkpointPath(info.id)
                  yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
                  yield* Effect.promise(() => Bun.write(file, "# Session checkpoint\n"))

                  yield* prompt.prompt({
                    sessionID: info.id,
                    parts: [{ type: "text", text: "next question that overflows" }],
                    agent: "build",
                  })

                  const after = yield* sessions.messages({ sessionID: info.id })

                  const checkpoints = after.filter((m) => m.parts.some((p) => p.type === "checkpoint"))
                  const compactions = after.filter((m) => m.parts.some((p) => p.type === "compaction"))
                  // A writer was started and awaited, and the rebuild used its
                  // output. Both numbers matter: 0/0 is the silent-fallthrough
                  // signature of the bug, and 0/1 would mean it degraded.
                  expect(checkpoints.length).toBe(1)
                  expect(compactions.length).toBe(0)

                  // The scaffolded file must NOT have been mistaken for a usable
                  // checkpoint: a watermark exists only because a writer settled.
                  const watermark = yield* Effect.sync(() =>
                    Database.use((db) =>
                      db
                        .select({ id: SessionTable.last_checkpoint_message_id })
                        .from(SessionTable)
                        .where(eq(SessionTable.id, info.id))
                        .get(),
                    ),
                  )
                  expect(watermark?.id).toBeTruthy()
                }),
              ),
          }),
        )
      } finally {
        await llm.stop()
      }
    },
    { timeout: 60_000 },
  )
})
