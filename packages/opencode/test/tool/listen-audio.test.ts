import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate, Tool } from "../../src/tool"
import { ListenAudioTool } from "../../src/tool/listen-audio"
import { MAX_MEDIA_BASE64_BYTES } from "../../src/util/media"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const model = ProviderTest.model({
  id: ModelID.make("model"),
  providerID: ProviderID.make("test"),
  api: { id: "model", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    ...ProviderTest.model().capabilities,
    input: { text: true, image: false, audio: true, video: false, pdf: false },
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
const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(24)])
const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    ProviderTest.fake({ model }).layer,
  ),
)
const run = Effect.fn("ListenAudioTest.run")(function* (filepath: string, next: Tool.Context = ctx) {
  const tool = yield* ListenAudioTool.pipe(Effect.flatMap(Tool.init))
  return yield* tool.execute({ path: filepath }, next)
})

describe("tool.listen_audio", () => {
  for (const file of [
    { name: "clip.wav", mime: "audio/wav", bytes: wav },
    { name: "clip.mp3", mime: "audio/mpeg", bytes: Buffer.concat([Buffer.from("ID3"), Buffer.alloc(24)]) },
    { name: "clip.bin", mime: "audio/wav", bytes: wav },
  ]) {
    it.live(`attaches audio from ${file.name}`, () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(dir, file.name), file.bytes))
          const result = yield* run(file.name)
          expect(result.output).toContain("Audio read successfully")
          expect(result.attachments).toEqual([
            {
              type: "file",
              mime: file.mime,
              filename: file.name,
              url: `data:${file.mime};base64,${file.bytes.toString("base64")}`,
            },
          ])
        }),
      ),
    )
  }

  it.live("refuses audio when only video input is supported", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "clip.wav"), wav))
        const result = yield* run("clip.wav", {
          ...ctx,
          extra: {
            model: {
              ...model,
              capabilities: {
                ...model.capabilities,
                input: { ...model.capabilities.input, audio: false, video: true },
              },
            },
          },
        })
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain("no audio input support")
      }),
    ),
  )

  for (const file of [
    { name: "clip.flac", bytes: Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(24)]) },
    {
      name: "clip.mp4",
      bytes: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(12)]),
    },
  ]) {
    it.live(`refuses unsupported audio in ${file.name}`, () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(dir, file.name), file.bytes))
          const result = yield* run(file.name)
          expect(result.attachments).toBeUndefined()
          expect(result.output).toContain("listen_audio only attaches")
          expect(result.output).toContain("audio/wav")
          expect(result.output).toContain("/tmp/example.wav")
        }),
      ),
    )
  }

  it.live("refuses audio over the encoded media limit", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filepath = path.join(dir, "large.wav")
        yield* Effect.promise(() => fs.writeFile(filepath, wav))
        yield* Effect.promise(() => fs.truncate(filepath, (MAX_MEDIA_BASE64_BYTES * 3) / 4 + 1))
        const result = yield* run(filepath)
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain("inline media limit")
      }),
    ),
  )
})
