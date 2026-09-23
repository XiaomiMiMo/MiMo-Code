import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate, Tool } from "../../src/tool"
import { WatchVideoTool } from "../../src/tool/watch-video"
import { MAX_MEDIA_BASE64_BYTES } from "../../src/util/media"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const model = ProviderTest.model({
  id: ModelID.make("model"),
  providerID: ProviderID.make("test"),
  api: { id: "model", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    ...ProviderTest.model().capabilities,
    input: { text: true, image: false, audio: false, video: true, pdf: false },
  },
})
const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  extra: { model },
  metadata: () => Effect.void,
  ask: () => Effect.void,
}
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(12)])
const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    ProviderTest.fake({ model }).layer,
  ),
)
const run = Effect.fn("WatchVideoTest.run")(function* (filepath: string, next: Tool.Context = ctx) {
  const tool = yield* WatchVideoTool.pipe(Effect.flatMap(Tool.init))
  return yield* tool.execute({ path: filepath }, next)
})

describe("tool.watch_video", () => {
  it.live("reads a relative MP4 path as a video attachment with read permission", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(dir, "clip.mp4"), mp4))
          const calls: Array<{ permission: string; patterns: readonly string[] }> = []
          const result = yield* run("clip.mp4", {
            ...ctx,
            ask: (request) =>
              Effect.sync(() => {
                calls.push(request)
              }),
          })
          expect(result.title).toBe("clip.mp4")
          expect(result.output).toContain("Video read successfully")
          expect(result.attachments).toEqual([
            {
              type: "file",
              mime: "video/mp4",
              filename: "clip.mp4",
              url: `data:video/mp4;base64,${mp4.toString("base64")}`,
            },
          ])
          expect(calls.map((call) => ({ permission: call.permission, patterns: call.patterns }))).toEqual([
            { permission: "read", patterns: [path.join(dir, "clip.mp4")] },
          ])
        }),
      { git: true },
    ),
  )

  it.live("refuses video when the active model lacks video input", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "clip.mp4"), mp4))
        const result = yield* run("clip.mp4", { ...ctx, extra: { model: ProviderTest.model() } })
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain("no video input support")
      }),
    ),
  )

  it.live("resolves the model from the last user message when extra model is absent", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "clip.mp4"), mp4))
        const result = yield* run("clip.mp4", {
          ...ctx,
          extra: undefined,
          messages: [
            {
              info: {
                id: ctx.messageID,
                sessionID: ctx.sessionID,
                role: "user",
                time: { created: 0 },
                agent: "build",
                model: { providerID: model.providerID, modelID: model.id },
              },
              parts: [],
            },
          ],
        })
        expect(result.attachments?.[0].mime).toBe("video/mp4")
      }),
    ),
  )

  it.live("refuses video without model context", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "clip.mp4"), mp4))
        const result = yield* run("clip.mp4", { ...ctx, extra: undefined })
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain("no video input support")
      }),
    ),
  )

  for (const file of [
    { name: "clip.webm", bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) },
    { name: "notes.ts", bytes: Buffer.from("export const answer = 42") },
    { name: "image.mp4", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  ]) {
    it.live(`refuses unsupported media in ${file.name}`, () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(dir, file.name), file.bytes))
          const result = yield* run(file.name)
          expect(result.attachments).toBeUndefined()
          expect(result.output).toContain("video/mp4")
        }),
      ),
    )
  }

  it.live("refuses videos over the encoded media limit", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filepath = path.join(dir, "large.mp4")
        yield* Effect.promise(() => fs.writeFile(filepath, mp4))
        yield* Effect.promise(() => fs.truncate(filepath, (MAX_MEDIA_BASE64_BYTES * 3) / 4 + 1))
        const result = yield* run(filepath)
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain("inline media limit")
        expect(result.output).toContain("It was not read")
      }),
    ),
  )

  it.live("rejects missing files and directories", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        for (const filepath of ["missing.mp4", dir]) {
          const result = yield* run(filepath).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) {
            expect(Cause.pretty(result.cause)).toContain(filepath === dir ? "not a file" : "File not found")
          }
        }
      }),
    ),
  )

  it.live("honors denied read and external directory permissions", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const outside = yield* tmpdirScoped()
          yield* Effect.promise(() => fs.writeFile(path.join(dir, "clip.mp4"), mp4))
          yield* Effect.promise(() => fs.writeFile(path.join(outside, "clip.mp4"), mp4))
          for (const item of [
            { filepath: path.join(dir, "clip.mp4"), permission: "read" },
            { filepath: path.join(outside, "clip.mp4"), permission: "external_directory" },
          ]) {
            const result = yield* run(item.filepath, {
              ...ctx,
              ask: (request) => Effect.die(new Error(`Denied ${request.permission}`)),
            }).pipe(Effect.exit)
            expect(Exit.isFailure(result)).toBe(true)
            if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(`Denied ${item.permission}`)
          }
        }),
      { git: true },
    ),
  )
})
