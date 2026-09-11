import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test"
import { PNG } from "pngjs"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { LSP } from "../../src/lsp"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { ModelID } from "../../src/provider/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "../../src/tool"
import { Tool } from "../../src/tool"
import { Filesystem } from "../../src/util"
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
const visionProvider = ProviderTest.fake({ model: visionModel })

const ctx = {
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
        model: { providerID: visionModel.providerID, modelID: visionModel.id },
      },
      parts: [],
    },
  ],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Instruction.defaultLayer,
    LSP.defaultLayer,
    Truncate.defaultLayer,
    visionProvider.layer,
  ),
)

const init = Effect.fn("ReadToolTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const run = Effect.fn("ReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")
const put = Effect.fn("ReadToolTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
})
const load = Effect.fn("ReadToolTest.load")(function* (p: string) {
  const fs = yield* AppFileSystem.Service
  return yield* fs.readFileString(p)
})
const asks = () => {
  const items: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.read external_directory permission", () => {
  it.live("allows reading absolute path inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "test.txt"), "hello world")

      const result = yield* exec(dir, { file_path: path.join(dir, "test.txt") })
      expect(result.output).toContain("hello world")
    }),
  )

  it.live("allows reading file in subdirectory inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "test.txt"), "nested content")

      const result = yield* exec(dir, { file_path: path.join(dir, "subdir", "test.txt") })
      expect(result.output).toContain("nested content")
    }),
  )

  it.live("asks for external_directory permission when reading absolute path outside project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "secret.txt"), "secret data")

      const { items, next } = asks()

      yield* exec(dir, { file_path: path.join(outer, "secret.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "*")))
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes read permission paths on Windows", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* put(path.join(dir, "test.txt"), "hello world")

        const { items, next } = asks()
        const target = path.join(dir, "test.txt")
        const alt = target
          .replace(/^[A-Za-z]:/, "")
          .replaceAll("\\", "/")
          .toLowerCase()

        yield* exec(dir, { file_path: alt }, next)
        const read = items.find((item) => item.permission === "read")
        expect(read).toBeDefined()
        expect(read!.patterns).toEqual([full(target)])
      }),
    )
  }

  it.live("asks for directory-scoped external_directory permission when reading external directory", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "external", "a.txt"), "a")

      const { items, next } = asks()

      yield* exec(dir, { file_path: path.join(outer, "external") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "external", "*")))
    }),
  )

  it.live("asks for external_directory permission when reading relative path outside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const { items, next } = asks()

      yield* fail(dir, { file_path: "../outside.txt" }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
    }),
  )

  it.live("does not ask for external_directory permission when reading inside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "internal.txt"), "internal content")

      const { items, next } = asks()

      yield* exec(dir, { file_path: path.join(dir, "internal.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeUndefined()
    }),
  )
})

describe("tool.read env file permissions", () => {
  const cases: [string, boolean][] = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.development.local", true],
    [".env.example", false],
    [".envrc", false],
    ["environment.ts", false],
  ]

  for (const agentName of ["build", "plan"] as const) {
    describe(`agent=${agentName}`, () => {
      for (const [filename, shouldAsk] of cases) {
        it.live(`${filename} asks=${shouldAsk}`, () =>
          Effect.gen(function* () {
            const dir = yield* tmpdirScoped()
            yield* put(path.join(dir, filename), "content")

            const asked = yield* provideInstance(dir)(
              Effect.gen(function* () {
                const agent = yield* Agent.Service
                const info = yield* agent.get(agentName)
                let asked = false
                const next = {
                  ...ctx,
                  ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      for (const pattern of req.patterns) {
                        const rule = Permission.evaluate(req.permission, pattern, info.permission)
                        if (rule.action === "ask" && req.permission === "read") {
                          asked = true
                        }
                        if (rule.action === "deny") {
                          throw new Permission.DeniedError({ ruleset: info.permission })
                        }
                      }
                    }),
                }

                yield* run({ file_path: path.join(dir, filename) }, next)
                return asked
              }),
            )

            expect(asked).toBe(shouldAsk)
          }),
        )
      }
    })
  }
})

describe("tool.read truncation", () => {
  it.live("truncates large file by bytes and sets truncated metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const base = yield* load(path.join(FIXTURES_DIR, "models-api.json"))
      const target = 60 * 1024
      const content = base.length >= target ? base : base.repeat(Math.ceil(target / base.length))
      yield* put(path.join(dir, "large.json"), content)

      const result = yield* exec(dir, { file_path: path.join(dir, "large.json") })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Output capped at")
      expect(result.output).toContain("Use offset=")
    }),
  )

  it.live("truncates by line count when limit is specified", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      yield* put(path.join(dir, "many-lines.txt"), lines)

      const result = yield* exec(dir, { file_path: path.join(dir, "many-lines.txt"), limit: 10 })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Showing lines 1-10 of 100")
      expect(result.output).toContain("Use offset=11")
      expect(result.output).toContain("line0")
      expect(result.output).toContain("line9")
      expect(result.output).not.toContain("line10")
    }),
  )

  it.live("does not truncate small file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "small.txt"), "hello world")

      const result = yield* exec(dir, { file_path: path.join(dir, "small.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file")
    }),
  )

  it.live("respects offset parameter", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "offset.txt"), lines)

      const result = yield* exec(dir, { file_path: path.join(dir, "offset.txt"), offset: 10, limit: 5 })
      expect(result.output).toContain("10: line10")
      expect(result.output).toContain("14: line14")
      expect(result.output).not.toContain("9: line10")
      expect(result.output).not.toContain("15: line15")
      expect(result.output).toContain("line10")
      expect(result.output).toContain("line14")
      expect(result.output).not.toContain("line0")
      expect(result.output).not.toContain("line15")
    }),
  )

  it.live("throws when offset is beyond end of file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 3 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "short.txt"), lines)

      const err = yield* fail(dir, { file_path: path.join(dir, "short.txt"), offset: 4, limit: 5 })
      expect(err.message).toContain("Offset 4 is out of range for this file (3 lines)")
    }),
  )

  it.live("allows reading empty file at default offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const result = yield* exec(dir, { file_path: path.join(dir, "empty.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file - total 0 lines")
    }),
  )

  it.live("throws when offset > 1 for empty file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const err = yield* fail(dir, { file_path: path.join(dir, "empty.txt"), offset: 2 })
      expect(err.message).toContain("Offset 2 is out of range for this file (0 lines)")
    }),
  )

  it.live("does not mark final directory page as truncated", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i),
        (i) => put(path.join(dir, "dir", `file-${i + 1}.txt`), `line${i}`),
        {
          concurrency: "unbounded",
        },
      )

      const result = yield* exec(dir, { file_path: path.join(dir, "dir"), offset: 6, limit: 5 })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).not.toContain("Showing 5 of 10 entries")
    }),
  )

  it.live("truncates long lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "long-line.txt"), "x".repeat(3000))

      const result = yield* exec(dir, { file_path: path.join(dir, "long-line.txt") })
      expect(result.output).toContain("(line truncated to 2000 chars)")
      expect(result.output.length).toBeLessThan(3000)
    }),
  )

  it.live("image files set truncated to false", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(path.join(dir, "image.png"), png)

      const result = yield* exec(dir, { file_path: path.join(dir, "image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live("detects attachment media from file contents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
      yield* put(path.join(dir, "image.bin"), jpeg)

      const result = yield* exec(dir, { file_path: path.join(dir, "image.bin") })
      expect(result.output).toBe("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      expect(result.attachments?.[0].url.startsWith("data:image/jpeg;base64,")).toBe(true)
    }),
  )

  it.live("attaches BMP files by sniffed MIME so transform can transcode them", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const rowSize = Math.floor((24 * 1 + 31) / 32) * 4
      const bmp = Buffer.alloc(54 + rowSize)
      bmp.write("BM", 0, "ascii")
      bmp.writeUInt32LE(bmp.length, 2)
      bmp.writeUInt32LE(54, 10)
      bmp.writeUInt32LE(40, 14)
      bmp.writeInt32LE(1, 18)
      bmp.writeInt32LE(1, 22)
      bmp.writeUInt16LE(1, 26)
      bmp.writeUInt16LE(24, 28)
      yield* put(path.join(dir, "screenshot.png"), bmp)

      const result = yield* exec(dir, { file_path: path.join(dir, "screenshot.png") })
      expect(result.output).toBe("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/bmp")
    }),
  )

  it.live("large image files are properly attached without error", () =>
    Effect.gen(function* () {
      const result = yield* exec(FIXTURES_DIR, { file_path: path.join(FIXTURES_DIR, "large-image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].type).toBe("file")
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live(".fbs files (FlatBuffers schema) are read as text, not images", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fbs = `namespace MyGame;

table Monster {
  pos:Vec3;
  name:string;
  inventory:[ubyte];
}

root_type Monster;`
      yield* put(path.join(dir, "schema.fbs"), fbs)

      const result = yield* exec(dir, { file_path: path.join(dir, "schema.fbs") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("namespace MyGame")
      expect(result.output).toContain("table Monster")
    }),
  )
})

describe("tool.read loaded instructions", () => {
  it.live("loads AGENTS.md from parent directory and includes in metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
      yield* put(path.join(dir, "subdir", "nested", "test.txt"), "test content")

      const result = yield* exec(dir, { file_path: path.join(dir, "subdir", "nested", "test.txt") })
      expect(result.output).toContain("test content")
      expect(result.output).toContain("system-reminder")
      expect(result.output).toContain("Test Instructions")
      expect(result.metadata.loaded).toBeDefined()
      expect(result.metadata.loaded).toContain(path.join(dir, "subdir", "AGENTS.md"))
    }),
  )
})

describe("tool.read binary detection", () => {
  it.live("rejects text extension files with null bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64])
      yield* put(path.join(dir, "null-byte.txt"), bytes)

      const err = yield* fail(dir, { file_path: path.join(dir, "null-byte.txt") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )

  it.live("rejects known binary extensions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "module.wasm"), "not really wasm")

      const err = yield* fail(dir, { file_path: path.join(dir, "module.wasm") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )
})

describe("tool.read pdf capability gate", () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")

  it.live("attaches a PDF when the active model accepts pdf input", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "doc.pdf"), pdf)

      const result = yield* exec(dir, { file_path: path.join(dir, "doc.pdf") })
      expect(result.output).toBe("PDF read successfully")
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].mime).toBe("application/pdf")
    }),
  )

  it.live("refuses a PDF without reading it when the model lacks pdf input", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "doc.pdf"), pdf)
      const textOnly = ProviderTest.model({ id: ModelID.make("text-only"), providerID: visionModel.providerID })

      const result = yield* exec(dir, { file_path: path.join(dir, "doc.pdf") }, { ...ctx, extra: { model: textOnly } })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain('Cannot attach PDF "doc.pdf"')
      expect(result.output).toContain(path.join("pdf-official", "SKILL.md"))
      expect(result.metadata.truncated).toBe(false)
    }),
  )
})

describe("tool.read attachment size limit", () => {
  // The size comes from stat, before any bytes are read. An oversized image is
  // then read and recompressed; a PDF or an undecodable image is refused, so
  // the base64 that would have bloated the session DB never exists.
  // The limits come from Flag.MIMOCODE_MAX_ATTACHMENT_SIZE and
  // Flag.MIMOCODE_MAX_ATTACHMENT_SOURCE_SIZE, lowered here so the fixtures
  // stay small.
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
  it.live("recompresses an oversized image under the limit instead of refusing it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = noisyPng(120) // noise defeats PNG compression: ~18 KB raw, over LIMIT and under CEILING
      expect(bytes.byteLength).toBeGreaterThan(LIMIT)
      expect(bytes.byteLength).toBeLessThanOrEqual(CEILING)
      yield* put(path.join(dir, "huge.png"), bytes)

      const result = yield* exec(dir, { file_path: path.join(dir, "huge.png") })
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      const url = result.attachments![0].url
      expect(Buffer.from(url.slice(url.indexOf(",") + 1), "base64").byteLength).toBeLessThanOrEqual(LIMIT)
      expect(result.output).toContain(`recompressed from ${bytes.byteLength} bytes`)
      expect(result.metadata.truncated).toBe(false)
    }),
  )

  it.live("drops an oversized image that cannot be decoded", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // Valid PNG signature, garbage body: over the limit and undecodable.
      const bytes = Buffer.alloc(LIMIT + 1)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
      yield* put(path.join(dir, "broken.png"), bytes)

      const result = yield* exec(dir, { file_path: path.join(dir, "broken.png") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain(`"broken.png" (image/png) is ${LIMIT + 1} bytes`)
      expect(result.output).toContain("could not be compressed")
    }),
  )

  it.live("refuses an image over the source ceiling without reading or compressing it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // A decodable PNG that compression could handle, but too large to bother.
      const bytes = noisyPng(200)
      expect(bytes.byteLength).toBeGreaterThan(CEILING)
      yield* put(path.join(dir, "giant.png"), bytes)

      const result = yield* exec(dir, { file_path: path.join(dir, "giant.png") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain(`"giant.png" (image/png) is ${bytes.byteLength} bytes`)
      expect(result.output).toContain("ceiling above which compression is not attempted")
      expect(result.output).toContain("It was not read")
    }),
  )

  it.live("refuses an oversized PDF", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.alloc(LIMIT + 1)
      Buffer.from("%PDF-1.4").copy(bytes)
      yield* put(path.join(dir, "huge.pdf"), bytes)

      const result = yield* exec(dir, { file_path: path.join(dir, "huge.pdf") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain(`"huge.pdf" (application/pdf)`)
      expect(result.output).toContain("It was not read")
    }),
  )

  it.live("still attaches an image just under the limit", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.alloc(LIMIT)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
      yield* put(path.join(dir, "edge.png"), bytes)

      const result = yield* exec(dir, { file_path: path.join(dir, "edge.png") })
      expect(result.attachments?.length).toBe(1)
    }),
  )
})
