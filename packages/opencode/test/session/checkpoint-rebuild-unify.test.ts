import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { Session as SessionNs } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { SessionCompaction } from "../../src/session/compaction"
import { TaskRegistry } from "../../src/task/registry"
import { ActorRegistry } from "../../src/actor/registry"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    Memory.defaultLayer,
    SessionNs.defaultLayer,
    TaskRegistry.defaultLayer,
    ActorRegistry.defaultLayer,
    SessionCheckpoint.defaultLayer,
  ),
)

async function seedUserMessage(sessionID: SessionID, text: string) {
  const ssn = await Effect.runPromise(
    SessionNs.Service.use((s) =>
      s.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      }),
    ).pipe(Effect.provide(SessionNs.defaultLayer)),
  )
  await Effect.runPromise(
    SessionNs.Service.use((s) =>
      s.updatePart({
        id: PartID.ascending(),
        messageID: ssn.id,
        sessionID,
        type: "text",
        text,
      }),
    ).pipe(Effect.provide(SessionNs.defaultLayer)),
  )
  return ssn
}

describe("SessionCheckpoint.insertRebuildBoundary", () => {
  it.live(
    "insertRebuildBoundary returns false and inserts nothing when rebuild context is empty",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const cp = yield* SessionCheckpoint.Service
          const memory = yield* Memory.Service
          const root = yield* memory.root()
          yield* Effect.promise(() =>
            Promise.all([
              fs.rm(path.join(root, "global"), { recursive: true, force: true }).catch(() => undefined),
              fs.rm(path.join(root, "projects"), { recursive: true, force: true }).catch(() => undefined),
            ]),
          )
          const info = yield* ssn.create({})

          const m1 = yield* Effect.promise(() => seedUserMessage(info.id, "turn one"))
          const _m2 = yield* Effect.promise(() => seedUserMessage(info.id, "turn two"))
          const m3 = yield* Effect.promise(() => seedUserMessage(info.id, "turn three"))

          // No checkpoint file → renderRebuildContext is empty → helper returns false, inserts nothing.
          // recent_user disabled here: the verbatim-user-input section's whole point is to make a
          // user-only-signal session emit non-empty context, so it must be opted out to assert the
          // "nothing to push" semantics this test targets.
          const insertedNoCtx = yield* cp.insertRebuildBoundary({
            sessionID: info.id,
            boundary: m3.id,
            agent: "build",
            model: { providerID: "anthropic", modelID: "claude" },
          })
          expect(insertedNoCtx).toBe(false)

          const after = yield* ssn.messages({ sessionID: info.id })
          // Every original message still present — nothing deleted.
          expect(after.some((m) => m.info.id === m1.id)).toBe(true)
          expect(after.some((m) => m.info.id === m3.id)).toBe(true)
          expect(after.length).toBe(3)
        }),
      { outsideGit: true, config: { checkpoint: { push_caps: { recent_user: 0 } } } },
    ),
  )

  it.live(
    "insertRebuildBoundary appends a checkpoint boundary when a real checkpoint exists (the /rebuild + auto path behavior)",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const cp = yield* SessionCheckpoint.Service
          const info = yield* ssn.create({})

          const m1 = yield* Effect.promise(() => seedUserMessage(info.id, "turn one"))
          const _m2 = yield* Effect.promise(() => seedUserMessage(info.id, "turn two"))
          const m3 = yield* Effect.promise(() => seedUserMessage(info.id, "turn three"))

          // Put a REAL (non-template) checkpoint on disk so renderRebuildContext
          // produces non-empty context. This is the state a manual /rebuild (and
          // the automatic overflow path) rely on: a usable checkpoint exists, so
          // a boundary must be inserted at the given watermark.
          const cpPath = checkpointPath(info.id)
          yield* Effect.promise(() => fs.mkdir(path.dirname(cpPath), { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(cpPath, "# Session checkpoint\n\n## §1 Active intent\nThe user is verifying /rebuild.\n"),
          )

          const inserted = yield* cp.insertRebuildBoundary({
            sessionID: info.id,
            boundary: m3.id,
            agent: "build",
            model: { providerID: "anthropic", modelID: "claude" },
          })
          expect(inserted).toBe(true)

          const after = yield* ssn.messages({ sessionID: info.id })
          // Originals preserved (never deleted) …
          expect(after.some((m) => m.info.id === m1.id)).toBe(true)
          expect(after.some((m) => m.info.id === m3.id)).toBe(true)
          // … plus exactly one appended message carrying a `checkpoint` part.
          expect(after.length).toBe(4)
          const boundary = after.at(-1)!
          expect(boundary.parts.some((p) => p.type === "checkpoint")).toBe(true)
        }),
      { outsideGit: true },
    ),
  )
})

describe("SessionCompaction.create preserves messages", () => {
  // This is the exact call the restored POST /:sessionID/summarize route makes.
  // Unlike the deleted SessionTrim.trim (which physically deleted rows),
  // compaction only inserts a synthetic boundary message — it never deletes.
  it.live(
    "create inserts a compaction boundary and keeps every prior message",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        const seeded = yield* Effect.forEach(["turn one", "turn two", "turn three"], (text) =>
          Effect.promise(() => seedUserMessage(info.id, text)),
        )

        const before = yield* ssn.messages({ sessionID: info.id })
        expect(before.length).toBe(seeded.length)

        // Same call as the /summarize route: SessionCompaction.create runs purely
        // synthetically (no LLM) — it appends a boundary message + compaction part.
        yield* Effect.promise(() =>
          SessionCompaction.create({
            sessionID: info.id,
            agent: "build",
            model: ref,
            auto: false,
          }),
        )

        const after = yield* ssn.messages({ sessionID: info.id })
        // Compaction never deletes: all originals survive, plus one boundary message.
        for (const m of seeded) {
          expect(after.some((x) => x.info.id === m.id)).toBe(true)
        }
        expect(after.length).toBe(seeded.length + 1)
        // The appended boundary carries a compaction part.
        const boundary = after.at(-1)!
        expect(boundary.parts.some((p) => p.type === "compaction")).toBe(true)
      }),
    ),
  )
})
