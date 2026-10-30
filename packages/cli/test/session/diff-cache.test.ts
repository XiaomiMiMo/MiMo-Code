import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "node:fs/promises"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Storage } from "../../src/storage"
import { Snapshot } from "../../src/snapshot"
import { PreviewLimits, type DiffPreview } from "../../src/snapshot/preview"
import { ByteLimitError } from "../../src/util/bounded-stream"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    SessionSummary.defaultLayer,
    Snapshot.defaultLayer,
    Storage.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

it.live(
  "oversized legacy diff caches rebuild from historical anchors and preserve message contents",
  () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const snapshot = yield* Snapshot.Service
          const storage = yield* Storage.Service
          const summary = yield* SessionSummary.Service
          yield* Effect.promise(() => fs.writeFile(`${directory}/example.txt`, "historical before\n"))
          const before = yield* snapshot.track()
          yield* Effect.promise(() => fs.writeFile(`${directory}/example.txt`, "historical after\n"))
          const after = yield* snapshot.track()
          const session = yield* sessions.create({ title: "legacy preview" })
          const userID = MessageID.ascending()
          const assistantID = MessageID.ascending()
          const oversized = [
            { file: "example.txt", patch: "x".repeat(PreviewLimits.payload + 1), additions: 1, deletions: 1 },
          ]
          yield* sessions.updateMessage({
            id: userID,
            sessionID: session.id,
            role: "user",
            agent: "build",
            time: { created: Date.now() },
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("model") },
            summary: { title: "retained title", body: "retained body", diffs: oversized },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: userID,
            type: "text",
            text: "retained message",
          })
          yield* sessions.updateMessage({
            id: assistantID,
            sessionID: session.id,
            parentID: userID,
            role: "assistant",
            agent: "build",
            mode: "primary",
            providerID: ProviderID.make("test"),
            modelID: ModelID.make("model"),
            time: { created: Date.now(), completed: Date.now() },
            path: { cwd: directory, root: directory },
            cost: 0,
            finish: "stop",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: assistantID,
            type: "step-start",
            snapshot: before,
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: assistantID,
            type: "step-finish",
            snapshot: after,
            reason: "stop",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          yield* storage.write(["session_diff", session.id], oversized)
          const rejected = yield* Effect.exit(
            storage.read(["session_diff", session.id], { maxBytes: PreviewLimits.payload }),
          )
          expect(Exit.isFailure(rejected)).toBe(true)
          if (Exit.isFailure(rejected)) expect(Cause.squash(rejected.cause)).toBeInstanceOf(ByteLimitError)

          // A later checkout/cleanup must not replace the old session's historical diff.
          yield* Effect.promise(() => fs.writeFile(`${directory}/example.txt`, "cleaned current worktree\n"))
          const user = MessageV2.get({ sessionID: session.id, messageID: userID })
          expect(user.info.role === "user" && user.info.summary).toMatchObject({
            title: "retained title",
            body: "retained body",
            diffs: [],
            diffTruncated: true,
          })
          expect(user.parts).toEqual([expect.objectContaining({ type: "text", text: "retained message" })])
          const page = MessageV2.page({ sessionID: session.id, limit: 10 })
          const pagedUser = page.items.find((item) => item.info.id === userID)
          expect(pagedUser?.info.role === "user" && pagedUser.info.summary?.diffs).toEqual([])

          for (let i = 0; i < 2; i++) {
            const diffs = yield* summary.diff({ sessionID: session.id })
            expect(diffs).toHaveLength(1)
            expect(diffs[0].patch).toContain("historical before")
            expect(diffs[0].patch).toContain("historical after")
            expect(diffs[0].patch).not.toContain("cleaned current worktree")
          }
          const cached = yield* storage.read<DiffPreview>(["session_diff", session.id], {
            maxBytes: PreviewLimits.payload,
          })
          expect(cached.summary).toMatchObject({ files: 1, additions: 1, deletions: 1 })
          expect(Buffer.byteLength(JSON.stringify(cached))).toBeLessThanOrEqual(PreviewLimits.payload)
          expect((yield* summary.diff({ sessionID: session.id, messageID: userID }))[0].patch).toContain(
            "historical after",
          )
          const rebuilt = MessageV2.get({ sessionID: session.id, messageID: userID })
          expect(rebuilt.info.role === "user" && rebuilt.info.summary).toMatchObject({
            title: "retained title",
            body: "retained body",
            diffTruncated: false,
          })
        }),
      { git: true },
    ),
  30_000,
)
