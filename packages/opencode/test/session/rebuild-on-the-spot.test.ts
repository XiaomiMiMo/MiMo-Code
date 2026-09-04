import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Command } from "../../src/command"
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

/** OpenAI-compatible SSE for a plain text stop response. */
function chat(text: string): ReadableStream<Uint8Array> {
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

/** Start a Bun HTTP mock that streams `reply` for every /chat/completions call. */
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

// ---- spawnRef seam control ----------------------------------------------
// tryStartCheckpointWriter resolves the checkpoint-writer subagent through the
// process-wide spawnRef.current seam (late-bound to break an Actor↔SessionPrompt
// layer cycle). Because it is a module global, its value leaks across tests in
// the same process, so each case-2 test sets it explicitly (and restores it)
// rather than depending on ambient state.
type SpawnImpl = NonNullable<typeof spawnRef.current>

function withSpawnRef<T>(impl: SpawnImpl | undefined, body: () => Promise<T>): Promise<T> {
  const prev = spawnRef.current
  spawnRef.current = impl
  return body().finally(() => {
    spawnRef.current = prev
  })
}

// A spawn stub emulating a successful checkpoint-writer run: on spawn it writes
// a real (non-template) checkpoint file for the PARENT session, then resolves
// the outcome to success. This drives the real case-2 path end-to-end
// (hasCheckpoint=false → tryStartCheckpointWriter → waitForWriter → success →
// rebuildFromCheckpoint) without a slow real LLM writer round-trip.
//
// The parent's checkpoint watermark (last_checkpoint_message_id) is what
// rebuildFromCheckpoint's lastBoundary reads. In production the writer runs for
// tens of seconds, so tryStartCheckpointWriter's settlement fiber advances the
// watermark long before waitForWriter returns. This stub is near-instant, so it
// advances the watermark itself to the session's last message — matching what a
// real settled writer leaves behind — rather than racing the settlement fiber.
function writerThatWritesCheckpoint(marker: string): SpawnImpl {
  let counter = 0
  return {
    spawn: (input) =>
      Effect.gen(function* () {
        counter += 1
        const parent = (input.parentSessionID ?? input.sessionID) as SessionID
        const outcome = yield* Deferred.make<AgentOutcome>()
        const cpFile = checkpointPath(parent)
        yield* Effect.promise(() => fs.mkdir(path.dirname(cpFile), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(cpFile, `# Session checkpoint\n\n## §1 Active intent\n${marker}\n`),
        )
        // Advance the watermark to the newest message, as a settled writer does.
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
        return { actorID: `${input.agentType}-${counter}`, sessionID: input.sessionID, outcome }
      }),
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(undefined),
  } as SpawnImpl
}

/**
 * Wrap a spawn impl so a test can assert whether it was ever ASKED to spawn.
 *
 * This is the difference between "the rebuild eventually gave up and compacted"
 * and "the rebuild never tried": both end at the same compaction, so counting
 * boundaries cannot tell them apart. A working writer that is never invoked can.
 */
function countingSpawn(impl: SpawnImpl) {
  let calls = 0
  return {
    impl: {
      ...impl,
      spawn: (input: Parameters<SpawnImpl["spawn"]>[0]) => {
        calls += 1
        return impl.spawn(input)
      },
    } as SpawnImpl,
    get calls() {
      return calls
    },
  }
}

function mimocodeConfig(baseURL: string, extra?: Record<string, unknown>) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["alibaba"],
    provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${baseURL}/v1` } } },
    agent: { build: { model: "alibaba/qwen-plus" } },
    ...extra,
  })
}

async function seedUserMessage(sessionID: SessionID, text: string) {
  const msg = await Effect.runPromise(
    Session.Service.use((s) =>
      s.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
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
        text,
      }),
    ).pipe(Effect.provide(Session.defaultLayer)),
  )
  return msg
}

// These tests drive the REAL /rebuild handler in SessionPrompt.command (the
// same code path a user hits by running `/rebuild`) against a scripted LLM
// stub, and assert on observable runtime behavior — inserted boundary
// messages, the returned message, whether the model was called, and the busy
// status events published on the Bus. They intentionally avoid grepping
// prompt.ts source text (which verifies nothing and breaks on refactors) per
// AGENTS.md: "Test actual implementation, do not duplicate logic into tests".
//
// The core invariant they enforce is the real fix for #1752: a manual
// /rebuild inserts the legitimate rebuild BOUNDARY (a role:"user" message
// carrying a `checkpoint` part) and NOTHING ELSE — it must NOT fabricate a
// second, standalone "Context rebuilt…" user turn (the band-aid the earlier
// noReply approach left persisted), and it must NOT produce an assistant
// reply. Exactly ONE new message (the boundary) lands, mirroring the
// transparent boundary insertion the auto/compaction paths perform. The
// outcome is surfaced on the SessionStatus / Bus status channel, not as a
// persisted user message.
describe("Manual /rebuild: on-the-spot rebuild driven through SessionPrompt.command", () => {
  test(
    "case 1: checkpoint on disk + no writer → inserts EXACTLY the boundary (no fabricated user turn, no reply)",
    async () => {
      const llm = startLLM("rebuilt-reply-from-model")
      const seen: Array<string | undefined> = []
      const lifecycle: Array<string | undefined> = []
      const onEvent = (e: {
        payload?: { type?: string; properties?: { status?: { type?: string; message?: string } } }
      }) => {
        if (e?.payload?.type !== "session.status") return
        lifecycle.push(e.payload.properties?.status?.type)
        if (e.payload.properties?.status?.type === "busy") {
          seen.push(e.payload.properties.status.message)
        }
      }
      GlobalBus.on("event", onEvent)
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
                const info = yield* sessions.create({ title: "rebuild-case-1" })

                yield* Effect.promise(() => seedUserMessage(info.id, "turn one"))
                yield* Effect.promise(() => seedUserMessage(info.id, "turn two"))
                const boundaryMsg = yield* Effect.promise(() => seedUserMessage(info.id, "turn three"))

                // Real (non-template) checkpoint on disk so renderRebuildContext
                // produces non-empty content and the boundary can be inserted.
                const cpFile = checkpointPath(info.id)
                yield* Effect.promise(() => fs.mkdir(path.dirname(cpFile), { recursive: true }))
                yield* Effect.promise(() =>
                  fs.writeFile(
                    cpFile,
                    "# Session checkpoint\n\n## §1 Active intent\nRebuild the context from this checkpoint.\n",
                  ),
                )

                // Seed the checkpoint watermark the same way a settled writer does
                // (SessionTable.last_checkpoint_message_id) so lastBoundary resolves
                // and the handler takes the has-checkpoint → rebuild path.
                yield* Effect.sync(() =>
                  Database.use((db) =>
                    db
                      .update(SessionTable)
                      .set({ last_checkpoint_message_id: boundaryMsg.id })
                      .where(eq(SessionTable.id, info.id))
                      .run(),
                  ),
                )

                const before = yield* sessions.messages({ sessionID: info.id })
                const countBefore = before.length

                // Drive the real handler.
                const result = yield* prompt.command({
                  sessionID: info.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })

                // A MANUAL /rebuild must NOT enter the runLoop: the user asked
                // no question, so the LLM was never called.
                expect(result.info.role).not.toBe("assistant")
                expect(llm.calls).toBe(0)

                const after = yield* sessions.messages({ sessionID: info.id })

                // EXACTLY ONE new message landed — the rebuild boundary — and
                // nothing else. This is the crux of the #1752 fix: no fabricated
                // second "Context rebuilt…" user turn.
                expect(after.length).toBe(countBefore + 1)

                // That one new message IS the boundary: role "user" carrying a
                // `checkpoint` part (the shared, correct mechanism).
                const boundaries = after.filter((m) => m.parts.some((p) => p.type === "checkpoint"))
                expect(boundaries.length).toBe(1)
                expect(boundaries[0]!.info.role).toBe("user")

                // The handler returns the boundary message itself, not a
                // fabricated note.
                expect(result.parts.some((p) => p.type === "checkpoint")).toBe(true)

                // No fabricated standalone "Context rebuilt…" user turn is
                // persisted anywhere (the band-aid the old path left behind).
                const fabricated = after.some(
                  (m) =>
                    !m.parts.some((p) => p.type === "checkpoint") &&
                    m.parts.some(
                      (p) => p.type === "text" && p.text.includes("Context rebuilt from the latest checkpoint"),
                    ),
                )
                expect(fabricated).toBe(false)

                // No assistant reply carrying the scripted text landed in the DB.
                const replied = after.some((m) =>
                  m.parts.some((p) => p.type === "text" && p.text.includes("rebuilt-reply-from-model")),
                )
                expect(replied).toBe(false)

                // Original conversation preserved (3 seeded users still there).
                const userCountBefore = before.filter((m) => m.info.role === "user").length
                const userCountAfter = after.filter((m) => m.info.role === "user").length
                expect(userCountAfter).toBeGreaterThanOrEqual(userCountBefore)

                // Outcome surfaced on the status channel (not a persisted user
                // message): the terminal "context rebuilt" message was emitted.
                expect(
                  seen.some((m) => m?.includes("Context rebuilt from the latest checkpoint")),
                ).toBe(true)

                // …and the status is CLEARED again: /rebuild must settle to idle
                // so the outcome text cannot leak into the following turn.
                expect(lifecycle.at(-1)).toBe("idle")
              }),
            ),
        })
      } finally {
        GlobalBus.off("event", onEvent)
        await llm.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "case 2: no checkpoint → spawns a writer, waits, then inserts EXACTLY the fresh boundary (no fabricated turn, no reply)",
    async () => {
      const llm = startLLM("case2-model-reply")
      // The writer stub writes a real checkpoint on spawn and reports success,
      // exercising the handler's spawn→wait→rebuild path for real.
      const writer = writerThatWritesCheckpoint("CASE2_FRESH_CHECKPOINT_BODY")
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
                  const info = yield* sessions.create({ title: "rebuild-case-2" })
                  yield* Effect.promise(() => seedUserMessage(info.id, "cold session, no checkpoint yet"))
                  yield* Effect.promise(() => seedUserMessage(info.id, "second turn on the cold session"))

                  const before = yield* sessions.messages({ sessionID: info.id })
                  const countBefore = before.length

                  // Cold session: no checkpoint file exists up front.
                  const result = yield* prompt.command({
                    sessionID: info.id,
                    command: Command.Default.REBUILD,
                    arguments: "",
                    agent: "build",
                  })

                  // A MANUAL /rebuild must NOT reply: the LLM is not called.
                  expect(result.info.role).not.toBe("assistant")
                  expect(llm.calls).toBe(0)

                  const after = yield* sessions.messages({ sessionID: info.id })

                  // EXACTLY ONE new message: the boundary rebuilt from the
                  // freshly-written checkpoint. No fabricated "Context rebuilt…"
                  // user turn.
                  expect(after.length).toBe(countBefore + 1)

                  const boundaries = after.filter((m) => m.parts.some((p) => p.type === "checkpoint"))
                  expect(boundaries.length).toBe(1)
                  expect(boundaries[0]!.info.role).toBe("user")
                  expect(result.parts.some((p) => p.type === "checkpoint")).toBe(true)

                  const fabricated = after.some(
                    (m) =>
                      !m.parts.some((p) => p.type === "checkpoint") &&
                      m.parts.some(
                        (p) => p.type === "text" && p.text.includes("Context rebuilt from the latest checkpoint"),
                      ),
                  )
                  expect(fabricated).toBe(false)

                  const replied = after.some((m) =>
                    m.parts.some((p) => p.type === "text" && p.text.includes("case2-model-reply")),
                  )
                  expect(replied).toBe(false)

                  // Outcome surfaced on the status channel, not a persisted user
                  // message.
                  expect(
                    seen.some((m) => m?.includes("Context rebuilt from the latest checkpoint")),
                  ).toBe(true)
                }),
              ),
          }),
        )
      } finally {
        GlobalBus.off("event", onEvent)
        await llm.stop()
      }
    },
    { timeout: 30_000 },
  )

  // DELIBERATE REWRITE — this test previously encoded the OPPOSITE behaviour.
  //
  // It used to be titled "case 2 fallback: no checkpoint + no spawnable writer →
  // surfaces the no-checkpoint outcome on the status channel, persists nothing"
  // and asserted `after.length === countBefore` — i.e. that a manual /rebuild
  // whose writer could not run must NOT compact. That encoded a deliberate
  // tradeoff: /rebuild means "rebuild from a checkpoint", so substituting a
  // lossy summary would misreport what happened.
  //
  // The user overruled that tradeoff: when there is no checkpoint AND the writer
  // genuinely fails, a truncating compaction beats doing nothing. That is now the
  // single compaction fallback condition, shared with the auto overflow paths.
  // The test is rewritten rather than edited quietly, because the assertion it
  // used to make is now a statement of the wrong behaviour.
  //
  // What is PRESERVED from the old test, and still asserted below: the handler
  // must not enter the runLoop, must not produce an assistant reply, and must not
  // fabricate a synthetic user turn — only the boundary marker may be persisted.
  test(
    "case 2 fallback: no checkpoint + no spawnable writer → compacts instead, and says so on the status channel",
    async () => {
      const llm = startLLM("should-not-be-used-as-a-reply")
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

        // Force NO writer: with spawnRef unset, tryStartCheckpointWriter cannot
        // spawn and waitForWriter resolves "no-writer" → the genuine
        // writer-failure case, the ONLY one allowed to reach compaction.
        await withSpawnRef(undefined, () =>
          Instance.provide({
            directory: tmp.path,
            fn: () =>
              run(
                Effect.gen(function* () {
                  const prompt = yield* SessionPrompt.Service
                  const sessions = yield* Session.Service
                  const info = yield* sessions.create({ title: "rebuild-case-2-fallback" })
                  yield* Effect.promise(() => seedUserMessage(info.id, "cold session, no checkpoint yet"))

                  const before = yield* sessions.messages({ sessionID: info.id })
                  const countBefore = before.length

                  const result = yield* prompt.command({
                    sessionID: info.id,
                    command: Command.Default.REBUILD,
                    arguments: "",
                    agent: "build",
                  })

                  // Did NOT enter the runLoop (no reply produced).
                  expect(result.info.role).not.toBe("assistant")

                  const after = yield* sessions.messages({ sessionID: info.id })

                  // The writer could not run and no checkpoint existed, so the
                  // context was compacted: exactly ONE new message, carrying a
                  // `compaction` part.
                  expect(after.length).toBe(countBefore + 1)
                  const compactions = after.filter((m) => m.parts.some((p) => p.type === "compaction"))
                  expect(compactions.length).toBe(1)

                  // No rebuild boundary — there was nothing to rebuild from.
                  const boundaries = after.filter((m) => m.parts.some((p) => p.type === "checkpoint"))
                  expect(boundaries.length).toBe(0)

                  // Still no fabricated user turn carrying the outcome text.
                  const fabricated = after.some((m) =>
                    m.parts.some((p) => p.type === "text" && p.text.includes("the context was compacted instead")),
                  )
                  expect(fabricated).toBe(false)

                  // Still no assistant reply.
                  const modelReplied = after.some((m) =>
                    m.parts.some((p) => p.type === "text" && p.text.includes("should-not-be-used-as-a-reply")),
                  )
                  expect(modelReplied).toBe(false)

                  // The substitution is NAMED on the status channel rather than
                  // silently swapping the mechanism the user asked for.
                  expect(seen.some((m) => m?.includes("the context was compacted instead"))).toBe(true)
                }),
              ),
          }),
        )
      } finally {
        GlobalBus.off("event", onEvent)
        await llm.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "busy status carries descriptive messages while the handler runs (observed on the Bus, not source text)",
    async () => {
      const llm = startLLM("busy-path-reply")
      const writer = writerThatWritesCheckpoint("BUSY_CHECKPOINT_BODY")
      const seen: Array<string | undefined> = []
      // SessionStatus.set publishes on the instance Bus which also mirrors every
      // event onto the process-wide GlobalBus. Subscribing here captures the
      // real busy-status messages the handler emits, regardless of which Bus
      // layer instance SessionPrompt.defaultLayer wired internally.
      const onEvent = (e: { payload?: { type?: string; properties?: { status?: { type?: string; message?: string } } } }) => {
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

                  // Cold session → exercises BOTH busy messages: "Rebuilding
                  // context…" (set first) then "Writing checkpoint…" (set while
                  // waiting on the writer that this test provides).
                  const info = yield* sessions.create({ title: "rebuild-busy" })
                  yield* Effect.promise(() => seedUserMessage(info.id, "no checkpoint here either"))
                  yield* Effect.promise(() => seedUserMessage(info.id, "second turn"))

                  yield* prompt.command({
                    sessionID: info.id,
                    command: Command.Default.REBUILD,
                    arguments: "",
                    agent: "build",
                  })
                }),
              ),
          }),
        )
      } finally {
        GlobalBus.off("event", onEvent)
        await llm.stop()
      }

      // The handler set busy with the human-readable messages the TUI shows.
      expect(seen).toContain("Rebuilding context\u2026")
      expect(seen).toContain("Writing checkpoint\u2026")
    },
    { timeout: 30_000 },
  )

  test(
    "MIMOCODE_DISABLE_CHECKPOINT=true → compacts immediately without starting or waiting for a writer",
    async () => {
      const previous = process.env.MIMOCODE_DISABLE_CHECKPOINT
      process.env.MIMOCODE_DISABLE_CHECKPOINT = "true"
      const llm = startLLM("should-not-be-used-as-a-reply")
      const writer = countingSpawn(writerThatWritesCheckpoint("SHOULD_NEVER_BE_WRITTEN"))
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

        await withSpawnRef(writer.impl, () =>
          Instance.provide({
            directory: tmp.path,
            fn: () =>
              run(
                Effect.gen(function* () {
                  const prompt = yield* SessionPrompt.Service
                  const sessions = yield* Session.Service
                  const info = yield* sessions.create({ title: "rebuild-checkpoint-off" })
                  const boundary = yield* Effect.promise(() =>
                    seedUserMessage(info.id, "turn one with checkpointing off"),
                  )
                  yield* Effect.promise(() =>
                    fs.mkdir(path.dirname(checkpointPath(info.id)), { recursive: true }),
                  )
                  yield* Effect.promise(() =>
                    fs.writeFile(
                      checkpointPath(info.id),
                      "# Session checkpoint\n\n## §1 Active intent\nThis existing checkpoint must not be rebuilt.\n",
                    ),
                  )
                  yield* Effect.sync(() =>
                    Database.use((db) =>
                      db
                        .update(SessionTable)
                        .set({ last_checkpoint_message_id: boundary.id })
                        .where(eq(SessionTable.id, info.id))
                        .run(),
                    ),
                  )

                  yield* prompt.command({
                    sessionID: info.id,
                    command: Command.Default.REBUILD,
                    arguments: "",
                    agent: "build",
                  })

                  const after = yield* sessions.messages({ sessionID: info.id })
                  expect(after.filter((m) => m.parts.some((p) => p.type === "compaction")).length).toBe(1)
                  expect(after.filter((m) => m.parts.some((p) => p.type === "checkpoint")).length).toBe(0)
                  expect(writer.calls).toBe(0)
                  expect(seen).not.toContain("Writing checkpoint\u2026")
                  expect(yield* Effect.promise(() => Bun.file(checkpointPath(info.id)).exists())).toBe(true)
                  const notice = after
                    .flatMap((m) => m.parts)
                    .find(
                      (p) =>
                        p.type === "text" &&
                        p.text.includes("Checkpointing is off") &&
                        p.text.includes("MIMOCODE_DISABLE_CHECKPOINT"),
                    )
                  expect(notice?.type).toBe("text")
                  if (notice?.type !== "text") throw new Error("expected checkpoint-off notice")
                  expect(notice.synthetic).toBe(true)
                  expect(notice.ignored).toBe(true)
                  expect(notice.metadata).toEqual({ origin: { kind: "checkpoint-off" } })
                  expect(llm.calls).toBe(0)
                }),
              ),
          }),
        )
      } finally {
        if (previous === undefined) delete process.env.MIMOCODE_DISABLE_CHECKPOINT
        else process.env.MIMOCODE_DISABLE_CHECKPOINT = previous
        GlobalBus.off("event", onEvent)
        await llm.stop()
      }
    },
    { timeout: 30_000 },
  )

  // `memory.disable_write: true` means no checkpoint can ever be written for the
  // session, so every rebuild degrades to compaction for the whole life of that
  // session. That is the switch doing its job, but it used to leave the user with
  // nothing: the sole trace was a log line, and the one message that WAS surfaced
  // blamed a failed checkpoint writer, which reads like a bug to report.
  //
  // A fully working writer stub is installed on purpose here, and the test
  // asserts the switch is checked UP FRONT rather than discovered at the end of a
  // doomed detour (read the checkpoint file, probe hasCheckpoint + lastBoundary,
  // start a writer, wait for it). Both the detour and the guard end at the same
  // compaction, so a compaction count cannot tell them apart; the writer-wait
  // announcement can, and is what the mutation check confirms. See the numbered
  // comments at the assertions for exactly what each probe does and does not
  // prove.
  test(
    "memory writing disabled → compacts IMMEDIATELY without ever asking for a writer, and names the switch once per session",
    async () => {
      const llm = startLLM("should-not-be-used-as-a-reply")
      const writer = countingSpawn(writerThatWritesCheckpoint("SHOULD_NEVER_BE_WRITTEN"))
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
          init: (dir) =>
            Bun.write(
              path.join(dir, "mimocode.json"),
              mimocodeConfig(llm.origin, { memory: { disable_write: true } }),
            ),
        })

        await withSpawnRef(writer.impl, () =>
          Instance.provide({
            directory: tmp.path,
            fn: () =>
              run(
                Effect.gen(function* () {
                  const prompt = yield* SessionPrompt.Service
                  const sessions = yield* Session.Service
                  const info = yield* sessions.create({ title: "rebuild-memory-write-off" })
                  yield* Effect.promise(() => seedUserMessage(info.id, "turn one with memory writing off"))

                  yield* prompt.command({
                    sessionID: info.id,
                    command: Command.Default.REBUILD,
                    arguments: "",
                    agent: "build",
                  })

                  const after = yield* sessions.messages({ sessionID: info.id })

                  // Degraded exactly as documented: compacted, never rebuilt.
                  expect(after.filter((m) => m.parts.some((p) => p.type === "compaction")).length).toBe(1)
                  expect(after.filter((m) => m.parts.some((p) => p.type === "checkpoint")).length).toBe(0)

                  // ── THE "IMMEDIATELY" ASSERTIONS ────────────────────────────
                  // Both the old detour and the guard end at the same
                  // compaction, so the counts above cannot tell them apart. What
                  // can: the detour's own side effects.
                  //
                  // 1. The writer-wait announcement. `onWaitingForWriter` runs
                  //    inside rebuildEnsuringCheckpoint immediately before
                  //    waitForWriter, so this message appearing means we entered
                  //    the start-and-wait stage. Verified discriminating: with
                  //    the guard's early return neutralized, this assertion is
                  //    the one that fails. It is also a correctness requirement
                  //    in its own right — announcing a wait for a writer we will
                  //    never start would be a lie. "Rebuilding context…" IS still
                  //    expected: the user did ask for a rebuild.
                  expect(seen).toContain("Rebuilding context\u2026")
                  expect(seen).not.toContain("Writing checkpoint\u2026")
                  // 2. A writer that would have SUCCEEDED was available the whole
                  //    time and produced nothing — so the switch, not a
                  //    missing/broken writer, is what blocked the checkpoint.
                  //    Deliberately NOT offered as proof of "never tried": the
                  //    memory gate inside tryStartCheckpointWriter
                  //    (checkpoint.ts:608) returns "skipped" before the spawn
                  //    seam, so this count stays 0 on the old detour too. The
                  //    call-was-never-made evidence is the absent
                  //    "memory writing disabled, skipping checkpoint" log line,
                  //    which only tryStartCheckpointWriter can emit.
                  expect(writer.calls).toBe(0)
                  // 3. Nothing was written to disk for this session either.
                  expect(yield* Effect.promise(() => Bun.file(checkpointPath(info.id)).exists())).toBe(false)

                  // The notice is PERSISTED, so it outlives the busy→idle status
                  // flash (which never reaches a headless event stream at all).
                  const notices = after.flatMap((m) =>
                    m.parts.filter((p) => p.type === "text" && p.text.includes("Memory writing is off")),
                  )
                  expect(notices.length).toBe(1)
                  const notice = notices[0]!
                  if (notice.type !== "text") throw new Error("expected a text part")
                  // Names both facts — the switch, and that compaction stood in for
                  // the rebuild — plus the consequence the user cares about.
                  expect(notice.text).toContain("Memory writing is off")
                  expect(notice.text).toContain("compacted instead of rebuilt")
                  expect(notice.text).toContain("weaken continuity")
                  // Reassures rather than alarms, and says how to undo it.
                  expect(notice.text).toContain("Nothing is broken")
                  expect(notice.text).toContain("memory.disable_write")
                  // Engine-side text is single-language English; the consuming
                  // client owns localization, as for `compactedInsteadMsg` /
                  // `rebuildFailedMsg`.
                  expect(notice.text).not.toMatch(/[\u4e00-\u9fff]/)
                  // Display-only: `ignored` keeps it out of the model's context,
                  // so a notice addressed to the user can never be read back as
                  // an instruction the user gave.
                  expect(notice.ignored).toBe(true)
                  expect(notice.synthetic).toBe(true)
                  // `time.end` is what makes the CLI emit it on --format json.
                  expect(notice.time?.end).toBeNumber()

                  // Same wording on the existing status channel, and the
                  // misleading "writer failed" text is NOT used here.
                  expect(seen.some((m) => m?.includes("Memory writing is off"))).toBe(true)
                  expect(seen.some((m) => m?.includes("the checkpoint writer failed"))).toBe(false)

                  // No assistant reply, as on every other /rebuild path.
                  expect(
                    after.some((m) =>
                      m.parts.some((p) => p.type === "text" && p.text.includes("should-not-be-used-as-a-reply")),
                    ),
                  ).toBe(false)

                  // Second fallback in the same session: it degrades again (a
                  // second compaction boundary), but the notice describes a
                  // config state, not an event, so it is NOT stacked a second
                  // time in the transcript. The status line still names the
                  // switch, because that line is transient.
                  seen.length = 0
                  yield* prompt.command({
                    sessionID: info.id,
                    command: Command.Default.REBUILD,
                    arguments: "",
                    agent: "build",
                  })
                  const again = yield* sessions.messages({ sessionID: info.id })
                  expect(again.filter((m) => m.parts.some((p) => p.type === "compaction")).length).toBe(2)
                  expect(
                    again.flatMap((m) =>
                      m.parts.filter((p) => p.type === "text" && p.text.includes("Memory writing is off")),
                    ).length,
                  ).toBe(1)
                  expect(seen.some((m) => m?.includes("Memory writing is off"))).toBe(true)
                  // Still no writer, on the second fallback either: the guard is
                  // not a once-per-session memo, it re-decides every time.
                  expect(writer.calls).toBe(0)
                  expect(seen).not.toContain("Writing checkpoint\u2026")
                }),
              ),
          }),
        )
      } finally {
        GlobalBus.off("event", onEvent)
        await llm.stop()
      }
    },
    { timeout: 30_000 },
  )
})
