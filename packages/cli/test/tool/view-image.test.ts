import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "../../src/tool"
import type { Tool } from "../../src/tool"
import { ViewImageTool } from "../../src/tool/view-image"
import { ProviderTest } from "../fake/provider"
import { tmpdir } from "../fixture/fixture"

const model = ProviderTest.model({
  capabilities: {
    toolcall: true,
    attachment: true,
    reasoning: false,
    temperature: true,
    interleaved: false,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
})

const calls: Array<{ permission: string; patterns: readonly string[] }> = []
const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_view_image"),
  messageID: MessageID.make("msg_view_image"),
  callID: "call_view_image",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  extra: { model },
  metadata: () => Effect.void,
  ask: (request) =>
    Effect.sync(() => {
      calls.push({ permission: request.permission, patterns: request.patterns })
    }),
}

const layer = Layer.mergeAll(Agent.defaultLayer, AppFileSystem.defaultLayer, Truncate.defaultLayer)

async function execute(args: { path: string; detail?: "high" | "original" }, next: Tool.Context = ctx) {
  return ViewImageTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) => tool.execute(args, next)),
    Effect.provide(layer),
    Effect.runPromise,
  )
}

afterEach(async () => {
  calls.length = 0
  await Instance.disposeAll()
})

describe("tool.view_image", () => {
  test("reads a relative image path and defaults to high detail", async () => {
    await using fixture = await tmpdir({ git: true })
    const source = path.join(import.meta.dir, "fixtures/large-image.png")
    const target = path.join(fixture.path, "image.png")
    await Bun.write(target, Bun.file(source))

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const result = await execute({ path: "image.png" })

        expect(result.title).toBe("image.png")
        expect(result.metadata.detail).toBe("high")
        expect(result.attachments?.[0].mime).toBe("image/png")
        expect(result.attachments?.[0].filename).toBe("image.png")
        expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
        expect(calls).toEqual([{ permission: "read", patterns: [target] }])
      },
    })
  })

  test("preserves the requested original detail hint", async () => {
    await using fixture = await tmpdir({ git: true })
    const target = path.join(fixture.path, "image.png")
    await Bun.write(target, Bun.file(path.join(import.meta.dir, "fixtures/large-image.png")))

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const result = await execute({ path: target, detail: "original" })
        expect(result.metadata.detail).toBe("original")
        expect(result.output).toContain("original detail")
      },
    })
  })

  test("rejects models without image input support", async () => {
    await using fixture = await tmpdir({ git: true })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        await expect(
          execute(
            { path: "image.png" },
            {
              ...ctx,
              extra: { model: ProviderTest.model() },
            },
          ),
        ).rejects.toThrow("view_image is not allowed because you do not support image inputs")
        expect(calls).toEqual([])
      },
    })
  })

  test("rejects non-image files", async () => {
    await using fixture = await tmpdir({ git: true })
    const target = path.join(fixture.path, "notes.txt")
    await Bun.write(target, "not an image")

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        await expect(execute({ path: target })).rejects.toThrow("is not a supported JPEG, PNG, GIF, or WebP image")
      },
    })
  })

  test("rejects unsupported detail values during validation", async () => {
    await using fixture = await tmpdir({ git: true })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        await expect(execute({ path: "image.png", detail: "low" as "high" })).rejects.toThrow(
          "Invalid arguments for the view_image tool",
        )
      },
    })
  })
})
