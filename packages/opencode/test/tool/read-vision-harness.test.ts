import { describe, expect, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "../../src/tool"
import { Tool } from "../../src/tool"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

// 1px PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

afterEach(async () => {
  await Instance.disposeAll()
})

const nonVisionModel = ProviderTest.model({
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    interleaved: false,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
})

const visionModel = ProviderTest.model({
  capabilities: {
    toolcall: true,
    attachment: true,
    reasoning: false,
    temperature: true,
    interleaved: false,
    input: { text: true, image: true, audio: false, video: false, pdf: true },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
})

const ctxFor = (model: typeof nonVisionModel): Tool.Context => ({
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [
    {
      info: {
        id: MessageID.make(""),
        sessionID: SessionID.make("ses_test"),
        role: "user" as const,
        time: { created: 0 },
        agent: "build",
        model: { providerID: model.providerID, modelID: model.id },
      },
      parts: [],
    },
  ],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const baseLayers = Layer.mergeAll(
  Agent.defaultLayer,
  AppFileSystem.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Instruction.defaultLayer,
  LSP.defaultLayer,
  Truncate.defaultLayer,
)

const nonVision = testEffect(Layer.mergeAll(baseLayers, ProviderTest.fake({ model: nonVisionModel }).layer))
const vision = testEffect(Layer.mergeAll(baseLayers, ProviderTest.fake({ model: visionModel }).layer))

const put = Effect.fn("ReadVisionTest.put")(function* (p: string, content: Buffer) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
})

const runRead = Effect.fn("ReadVisionTest.run")(function* (dir: string, file: string, ctx: Tool.Context) {
  const tool = yield* (yield* ReadTool).init()
  return yield* provideInstance(dir)(tool.execute({ file_path: file }, ctx))
})

describe("tool.read vision harness", () => {
  nonVision.live("non-vision model reading an image returns a warning and no attachment", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "image.png")
      yield* put(file, PNG)

      const result = yield* runRead(dir, file, ctxFor(nonVisionModel))
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("no vision support")
    }),
  )

  vision.live("vision model reading an image returns an image attachment", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "image.png")
      yield* put(file, PNG)

      const result = yield* runRead(dir, file, ctxFor(visionModel))
      expect(result.attachments?.[0].mime.startsWith("image/")).toBe(true)
    }),
  )
})
