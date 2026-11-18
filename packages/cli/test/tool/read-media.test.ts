import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test"
import { PNG } from "pngjs"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { ModelID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider"
import { ReadAudioTool, ReadImageTool, ReadVideoTool, supportsMedia } from "../../src/tool/read-media"
import { Truncate } from "../../src/tool"
import { Tool } from "../../src/tool"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")

// Random noise defeats PNG's own compression, so a small canvas yields a file
// far larger than the tiny attachment limit the size-gate tests run under.
function noisyPng(size: number) {
  let seed = 4242
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % 256
  }
  const png = new PNG({ width: size, height: size })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rand()
    png.data[i + 1] = rand()
    png.data[i + 2] = rand()
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

afterEach(async () => {
  await Instance.disposeAll()
})

const withInput = (input: { image?: boolean; audio?: boolean; video?: boolean; npm?: string }) =>
  ProviderTest.model({
    id: ModelID.make("media"),
    api: { id: "media", url: "https://example.com", npm: input.npm ?? "@ai-sdk/openai-compatible" },
    capabilities: {
      toolcall: true,
      attachment: true,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: {
        text: true,
        image: input.image ?? false,
        audio: input.audio ?? false,
        video: input.video ?? false,
        pdf: false,
      },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  })

const visionModel = withInput({ image: true, npm: "@ai-sdk/openai" })
const avModel = withInput({ audio: true, video: true })
const textOnly = withInput({})
const visionProvider = ProviderTest.fake({ model: visionModel })

const ctx = (model: Provider.Model | undefined): Tool.Context => ({
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  extra: model ? { model } : undefined,
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    visionProvider.layer,
  ),
)

type MediaTool = typeof ReadImageTool | typeof ReadAudioTool | typeof ReadVideoTool

const exec = Effect.fn("ReadMediaTest.exec")(function* (
  tool: MediaTool,
  dir: string,
  file: string,
  next: Tool.Context,
) {
  return yield* provideInstance(dir)(
    Effect.gen(function* () {
      const info = yield* tool
      const def = yield* info.init()
      return yield* def.execute({ file_path: file }, next)
    }),
  )
})

const fail = Effect.fn("ReadMediaTest.fail")(function* (
  tool: MediaTool,
  dir: string,
  file: string,
  next: Tool.Context,
) {
  const exit = yield* exec(tool, dir, file, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected the media tool to fail")
})

const put = Effect.fn("ReadMediaTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
})

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
)
// Minimal RIFF/WAVE header: sniffed as audio/wav regardless of the extension.
const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(24)])
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(12)])

describe("supportsMedia", () => {
  it.live("ANDs the model modality with the adapter declaration and fails closed on unknown", () =>
    Effect.sync(() => {
      expect(supportsMedia(undefined, "image")).toBe(false)
      expect(supportsMedia(textOnly, "image")).toBe(false)
      expect(supportsMedia(visionModel, "image")).toBe(true)
      expect(supportsMedia(avModel, "audio")).toBe(true)
      expect(supportsMedia(avModel, "video")).toBe(true)
      expect(supportsMedia(withInput({ audio: true, video: true, npm: "@ai-sdk/anthropic" }), "audio")).toBe(false)
      expect(supportsMedia(withInput({ audio: true, video: true, npm: "@ai-sdk/openai" }), "video")).toBe(false)
    }),
  )
})

describe("tool.read_image", () => {
  it.live("attaches a supported image as a data URL", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "image.png"), png)

      const result = yield* exec(ReadImageTool, dir, path.join(dir, "image.png"), ctx(visionModel))
      expect(result.output).toBe("Image read successfully")
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toEqual([
        { type: "file", mime: "image/png", url: `data:image/png;base64,${png.toString("base64")}` },
      ])
    }),
  )

  it.live("sniffs the image type from file contents, not the extension", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
      yield* put(path.join(dir, "image.bin"), jpeg)

      const result = yield* exec(ReadImageTool, dir, path.join(dir, "image.bin"), ctx(visionModel))
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
    }),
  )

  it.live("resolves relative paths against the session cwd", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "nested", "image.png"), png)

      const result = yield* exec(ReadImageTool, dir, path.join("nested", "image.png"), ctx(visionModel))
      expect(result.attachments?.length).toBe(1)
      expect(result.title).toEndWith(path.join("nested", "image.png"))
    }),
  )

  it.live("attaches a large image fixture", () =>
    Effect.gen(function* () {
      const result = yield* exec(
        ReadImageTool,
        FIXTURES_DIR,
        path.join(FIXTURES_DIR, "large-image.png"),
        ctx(visionModel),
      )
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
    }),
  )

  it.live("refuses a sniffed BMP outside the allowlist with a conversion hint", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bmp = Buffer.alloc(58)
      bmp.write("BM", 0, "ascii")
      yield* put(path.join(dir, "screenshot.png"), bmp)

      const result = yield* exec(ReadImageTool, dir, path.join(dir, "screenshot.png"), ctx(visionModel))
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain('Cannot attach image "screenshot.png" (image/bmp)')
      expect(result.output).toContain("image/jpeg, image/png, image/webp, image/gif")
      expect(result.output).toContain("/tmp/example.png")
    }),
  )

  it.live("refuses a text file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "notes.txt"), "hello")

      const result = yield* exec(ReadImageTool, dir, path.join(dir, "notes.txt"), ctx(visionModel))
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain('Cannot attach image "notes.txt" (text/plain)')
    }),
  )

  it.live("fails on a missing file, suggesting similar names", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "image.png"), png)

      const err = yield* fail(ReadImageTool, dir, path.join(dir, "image"), ctx(visionModel))
      expect(err.message).toContain(`File not found: ${path.join(dir, "image")}`)
      expect(err.message).toContain(path.join(dir, "image.png"))
    }),
  )

  it.live("fails on a directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "pics", "a.png"), png)

      const err = yield* fail(ReadImageTool, dir, path.join(dir, "pics"), ctx(visionModel))
      expect(err.message).toContain(`Path is a directory, not an image file: ${path.join(dir, "pics")}`)
    }),
  )

  it.live("asks the read permission for the file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "image.png"), png)
      const items: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []

      yield* exec(ReadImageTool, dir, path.join(dir, "image.png"), {
        ...ctx(visionModel),
        ask: (req) => Effect.sync(() => void items.push(req)),
      })
      expect(items.map((item) => item.permission)).toEqual(["read"])
      expect(items[0].patterns).toEqual([path.join(dir, "image.png")])
    }),
  )

  it.live("returns a vision-subagent hint without reading for a model without image input", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "image.png"), png)
      const items: unknown[] = []

      const result = yield* exec(ReadImageTool, dir, path.join(dir, "image.png"), {
        ...ctx(textOnly),
        ask: (req) => Effect.sync(() => void items.push(req)),
      })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain('Cannot read image "image.png" — the current model has no vision support')
      expect(result.output).toContain(`--model ${visionModel.providerID}/${visionModel.id}`)
      expect(items).toEqual([])
    }),
  )

  it.live("falls back to the last user message's model when ctx.extra has none", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "image.png"), png)
      const next: Tool.Context = {
        ...ctx(undefined),
        messages: [
          {
            info: {
              id: MessageID.make(""),
              sessionID: SessionID.make("ses_test"),
              role: "user",
              time: { created: 0 },
              agent: "build",
              model: { providerID: visionModel.providerID, modelID: visionModel.id },
            },
            parts: [],
          },
        ],
      }

      const result = yield* exec(ReadImageTool, dir, path.join(dir, "image.png"), next)
      expect(result.attachments?.length).toBe(1)

      const none = yield* exec(ReadImageTool, dir, path.join(dir, "image.png"), ctx(undefined))
      expect(none.attachments).toBeUndefined()
      expect(none.output).toContain("no vision support")
    }),
  )
})

describe("tool.read_audio and read_video", () => {
  it.live("attaches audio with its filename", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "clip.wav"), wav)

      const result = yield* exec(ReadAudioTool, dir, path.join(dir, "clip.wav"), ctx(avModel))
      expect(result.output).toBe("Audio read successfully and attached for the model to analyze")
      expect(result.attachments).toEqual([
        { type: "file", mime: "audio/wav", filename: "clip.wav", url: `data:audio/wav;base64,${wav.toString("base64")}` },
      ])
    }),
  )

  it.live("attaches video with its filename", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "clip.mp4"), mp4)

      const result = yield* exec(ReadVideoTool, dir, path.join(dir, "clip.mp4"), ctx(avModel))
      expect(result.output).toBe("Video read successfully and attached for the model to analyze")
      expect(result.attachments?.[0].mime).toBe("video/mp4")
      expect(result.attachments?.[0].filename).toBe("clip.mp4")
    }),
  )

  it.live("refuses an audio format outside the allowlist", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "clip.aac"), Buffer.from("\xff\xf1\0\0\0\0", "binary"))

      const result = yield* exec(ReadAudioTool, dir, path.join(dir, "clip.aac"), ctx(avModel))
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain('Cannot attach audio "clip.aac" (audio/aac)')
      expect(result.output).toContain("audio/wav")
      expect(result.output).toContain("/tmp/example.wav")
    }),
  )

  it.live("refuses a video format outside the allowlist", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "clip.webm"), Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]))

      const result = yield* exec(ReadVideoTool, dir, path.join(dir, "clip.webm"), ctx(avModel))
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain('Cannot attach video "clip.webm" (video/webm)')
      expect(result.output).toContain("video/mp4")
      expect(result.output).toContain("/tmp/example.mp4")
    }),
  )

  it.live("refuses an mp4 passed to read_audio and a wav passed to read_video", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "clip.mp4"), mp4)
      yield* put(path.join(dir, "clip.wav"), wav)

      const audio = yield* exec(ReadAudioTool, dir, path.join(dir, "clip.mp4"), ctx(avModel))
      expect(audio.attachments).toBeUndefined()
      expect(audio.output).toContain("read_audio only accepts")
      const video = yield* exec(ReadVideoTool, dir, path.join(dir, "clip.wav"), ctx(avModel))
      expect(video.attachments).toBeUndefined()
      expect(video.output).toContain("read_video only accepts")
    }),
  )

  it.live("fails on a missing file and on a directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "media", "clip.wav"), wav)

      const missing = yield* fail(ReadAudioTool, dir, path.join(dir, "nope.wav"), ctx(avModel))
      expect(missing.message).toBe(`File not found: ${path.join(dir, "nope.wav")}`)
      const directory = yield* fail(ReadVideoTool, dir, path.join(dir, "media"), ctx(avModel))
      expect(directory.message).toContain(`Path is a directory, not a video file: ${path.join(dir, "media")}`)
    }),
  )

  it.live("refuses without reading for a model whose modality or adapter lacks support", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "clip.wav"), wav)
      yield* put(path.join(dir, "clip.mp4"), mp4)

      for (const model of [textOnly, withInput({ audio: true, video: true, npm: "@ai-sdk/anthropic" })]) {
        const audio = yield* exec(ReadAudioTool, dir, path.join(dir, "clip.wav"), ctx(model))
        expect(audio.attachments).toBeUndefined()
        expect(audio.output).toContain('Cannot attach audio "clip.wav" — the current model has no audio input support')
        const video = yield* exec(ReadVideoTool, dir, path.join(dir, "clip.mp4"), ctx(model))
        expect(video.attachments).toBeUndefined()
        expect(video.output).toContain('Cannot attach video "clip.mp4" — the current model has no video input support')
      }
    }),
  )
})

describe("tool.read_image/read_audio size limits", () => {
  // The size comes from stat, before any bytes are read. The limits come from
  // Flag.MIMOCODE_MAX_ATTACHMENT_SIZE and Flag.MIMOCODE_MAX_ATTACHMENT_SOURCE_SIZE,
  // lowered here so the fixtures stay small.
  const LIMIT = 4096
  const CEILING = 32 * 1024
  beforeAll(() => {
    process.env["MIMOCODE_MAX_ATTACHMENT_SIZE"] = String(LIMIT)
    process.env["MIMOCODE_MAX_ATTACHMENT_SOURCE_SIZE"] = String(CEILING)
  })
  afterAll(() => {
    delete process.env["MIMOCODE_MAX_ATTACHMENT_SIZE"]
    delete process.env["MIMOCODE_MAX_ATTACHMENT_SOURCE_SIZE"]
  })

  it.live("recompresses an oversized image under the limit", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = noisyPng(120)
      expect(bytes.byteLength).toBeGreaterThan(LIMIT)
      expect(bytes.byteLength).toBeLessThanOrEqual(CEILING)
      yield* put(path.join(dir, "huge.png"), bytes)

      const result = yield* exec(ReadImageTool, dir, path.join(dir, "huge.png"), ctx(visionModel))
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      const url = result.attachments![0].url
      expect(Buffer.from(url.slice(url.indexOf(",") + 1), "base64").byteLength).toBeLessThanOrEqual(LIMIT)
      expect(result.output).toContain(`recompressed from ${bytes.byteLength} bytes`)
    }),
  )

  it.live("drops an oversized image that cannot be decoded", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.alloc(LIMIT + 1)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
      yield* put(path.join(dir, "broken.png"), bytes)

      const result = yield* exec(ReadImageTool, dir, path.join(dir, "broken.png"), ctx(visionModel))
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain(`"broken.png" (image/png) is ${LIMIT + 1} bytes`)
      expect(result.output).toContain("could not be compressed")
    }),
  )

  it.live("refuses an image over the source ceiling without reading it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = noisyPng(200)
      expect(bytes.byteLength).toBeGreaterThan(CEILING)
      yield* put(path.join(dir, "giant.png"), bytes)

      const result = yield* exec(ReadImageTool, dir, path.join(dir, "giant.png"), ctx(visionModel))
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("ceiling above which compression is not attempted")
      expect(result.output).toContain("It was not read")
    }),
  )

  it.live("still attaches an image exactly at the limit", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.alloc(LIMIT)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
      yield* put(path.join(dir, "edge.png"), bytes)

      const result = yield* exec(ReadImageTool, dir, path.join(dir, "edge.png"), ctx(visionModel))
      expect(result.attachments?.length).toBe(1)
    }),
  )

  it.live("bounds audio by the encoded media cap, not the attachment limit", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.concat([wav, Buffer.alloc(LIMIT)])
      yield* put(path.join(dir, "long.wav"), bytes)

      const result = yield* exec(ReadAudioTool, dir, path.join(dir, "long.wav"), ctx(avModel))
      expect(result.attachments?.[0].url).toBe(`data:audio/wav;base64,${bytes.toString("base64")}`)
    }),
  )

  it.live("refuses audio over the encoded media cap without reading it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // A sparse file: stat reports the size, nothing near it is ever read.
      const file = path.join(dir, "huge.wav")
      yield* put(file, wav)
      yield* Effect.promise(() => import("fs/promises").then((fs) => fs.truncate(file, 40 * 1024 * 1024)))

      const result = yield* exec(ReadAudioTool, dir, file, ctx(avModel))
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain(`"huge.wav" (audio/wav) is ${40 * 1024 * 1024} bytes`)
      expect(result.output).toContain("It was not read")
    }),
  )
})
