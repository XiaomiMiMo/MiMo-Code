import z from "zod"
import { Effect, Option, Scope } from "effect"
import { createReadStream } from "fs"
import * as path from "path"
import { createInterface } from "readline"
import * as Tool from "./tool"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { LSP } from "../lsp"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import { SessionCwd } from "./session-cwd"
import { Instruction } from "../session/instruction"
import { Provider } from "@/provider"
import { ReadMedia } from "./read-media"
import { shrinkAttachment } from "@/provider/image"
import { builtinSkillRoot } from "@/skill/builtin/extract"
import {
  classifyAttachment,
  isReadAudioMime,
  isReadImageMime,
  isReadPdfMime,
  isReadVideoMime,
  looksLikeMediaMime,
  oversizedAttachmentNotice,
  READ_AUDIO_MIMES,
  READ_IMAGE_MIMES,
  READ_VIDEO_MIMES,
  readMimeAllowlist,
  sniffAttachmentMime,
} from "@/util/media"

const DEFAULT_READ_LIMIT = 2000

// Format names for the finite read allowlists — what describeMedia advertises
// and what the attachment branch will actually attach.
const IMAGE_FORMAT_NAMES: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}
const AUDIO_FORMAT_NAMES: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
}
const VIDEO_FORMAT_NAMES: Record<string, string> = {
  "video/mp4": "mp4",
}

function mediaFormatNames(kind: "image" | "audio" | "video") {
  const names = kind === "image" ? IMAGE_FORMAT_NAMES : kind === "audio" ? AUDIO_FORMAT_NAMES : VIDEO_FORMAT_NAMES
  const mimes = kind === "image" ? READ_IMAGE_MIMES : kind === "audio" ? READ_AUDIO_MIMES : READ_VIDEO_MIMES
  return [...new Set([...mimes].map((mime) => names[mime] ?? mime))]
}

/**
 * Model-dependent media paragraph for the tool description. Appended by the
 * tool registry so a text-only model is never told it can attach media.
 * Formats listed are the finite read allowlist, not the full adapter surface.
 * PDF stays in the static read.txt line with a model-support caveat.
 */
export function describeMedia(model: Provider.Model | undefined) {
  if (!model) return undefined
  const image = model.capabilities.input.image ? `image (${mediaFormatNames("image").join(", ")})` : undefined
  const audio = model.capabilities.input.audio ? `audio (${mediaFormatNames("audio").join(", ")})` : undefined
  const video = model.capabilities.input.video ? `video (${mediaFormatNames("video").join(", ")})` : undefined
  const kinds = [image, audio, video].filter((kind): kind is string => kind !== undefined)
  if (kinds.length === 0) return undefined
  return [
    `- You can read and understand ${kinds.join(" and ")} files directly: this tool returns them as file attachments, and you can then describe, transcribe, summarize, or answer questions about their content yourself, without an external transcription or vision service.`,
    `- Media is inlined when small enough (about 37 MB on disk, 50 MB once base64-encoded); otherwise the tool explains why the file was not read. Read the file first, then analyze its content in the same turn.`,
  ].join("\n")
}
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096

const parameters = z.object({
  file_path: z.string().describe("Path to the file or directory"),
  offset: z.coerce.number().describe("The line number to start reading from (1-indexed)").optional(),
  limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000)").optional(),
})

export const ReadTool = Tool.define(
  "read",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const provider = yield* Provider.Service
    const readMedia = yield* ReadMedia
    const scope = yield* Scope.Scope

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const items = yield* fs.readDirectory(dir).pipe(
        Effect.map((items) =>
          items
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      if (items.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`),
        )
      }

      return yield* Effect.fail(new Error(`File not found: ${filepath}`))
    })

    const list = Effect.fn("ReadTool.list")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntries(filepath)
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name

          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          return item.name
        }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      yield* lsp.touchFile(filepath, false).pipe(Effect.ignore, Effect.forkIn(scope))
    })

    const readSample = Effect.fn("ReadTool.readSample")(function* (
      filepath: string,
      fileSize: number,
      sampleSize: number,
    ) {
      if (fileSize === 0) return new Uint8Array()

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filepath, { flag: "r" })
          return Option.getOrElse(yield* file.readAlloc(Math.min(sampleSize, fileSize)), () => new Uint8Array())
        }),
      )
    })

    const isBinaryFile = (filepath: string, bytes: Uint8Array) => {
      const ext = path.extname(filepath).toLowerCase()
      switch (ext) {
        case ".zip":
        case ".tar":
        case ".gz":
        case ".exe":
        case ".dll":
        case ".so":
        case ".class":
        case ".jar":
        case ".war":
        case ".7z":
        case ".doc":
        case ".docx":
        case ".xls":
        case ".xlsx":
        case ".ppt":
        case ".pptx":
        case ".odt":
        case ".ods":
        case ".odp":
        case ".bin":
        case ".dat":
        case ".obj":
        case ".o":
        case ".a":
        case ".lib":
        case ".wasm":
        case ".pyc":
        case ".pyo":
          return true
      }

      if (bytes.length === 0) return false

      let nonPrintableCount = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true
        if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
          nonPrintableCount++
        }
      }

      return nonPrintableCount / bytes.length > 0.3
    }

    const run = Effect.fn("ReadTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      if (params.offset !== undefined && params.offset < 1) {
        return yield* Effect.fail(new Error("offset must be greater than or equal to 1"))
      }

      let filepath = params.file_path
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(SessionCwd.get(ctx.sessionID), filepath)
      }
      if (process.platform === "win32") {
        filepath = AppFileSystem.normalizePath(filepath)
      }
      const title = path.relative(Instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: stat?.type === "Directory" ? "directory" : "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [filepath],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* miss(filepath)

      if (stat.type === "Directory") {
        const items = yield* list(filepath)
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset ?? 1
        const start = offset - 1
        const sliced = items.slice(start, start + limit)
        const truncated = start + sliced.length < items.length

        return {
          title,
          output: [
            `<path>${filepath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
              : `\n(${items.length} entries)`,
            `</entries>`,
          ].join("\n"),
          metadata: {
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
          },
        }
      }

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      const sample = yield* readSample(filepath, Number(stat.size), SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, AppFileSystem.mimeType(filepath))
      // Finite allowlist only. mime-types maps code extensions such as .ts/.mts
      // to video/mp2t; prefix matching must not send source files down the
      // media path. Outside the list: binary media-like files still refuse with
      // a convert hint; text-like payloads fall through to the text reader.
      const inImage = isReadImageMime(mime)
      const inPdf = isReadPdfMime(mime)
      const inAudio = isReadAudioMime(mime)
      const inVideo = isReadVideoMime(mime)
      const inMedia = inImage || inPdf || inAudio || inVideo

      if (!inMedia && looksLikeMediaMime(mime) && isBinaryFile(filepath, sample)) {
        const allowlist = readMimeAllowlist(mime)
        const kind = mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : mime === "application/pdf" ? "PDF" : "image"
        const accepted = allowlist ? [...allowlist].join(", ") : ""
        const hintExt = kind === "audio" ? "wav" : kind === "video" ? "mp4" : kind === "PDF" ? "pdf" : "png"
        const warning = [
          `Cannot attach ${kind} "${path.basename(filepath)}" (${mime}) — read only attaches ${accepted || "a finite media MIME list"}, so the file was not read.`,
          `Convert it first (e.g. ffmpeg -i "${filepath}" /tmp/example.${hintExt}) and read the converted file.`,
        ].join("\n")
        return {
          title,
          output: warning,
          metadata: { preview: warning, truncated: false, loaded: loaded.map((item) => item.filepath) },
        }
      }

      // Size gate on stat, before any bytes are read (see classifyAttachment):
      // a rejected PDF or image is never read, an oversized image within the
      // source ceiling is read and recompressed below. Either way nothing over
      // the limit becomes base64 or reaches the session DB. Audio and video are
      // not gated here: the provider bounds their ENCODED size, which the media
      // branch below checks with fitsMediaBase64.
      const verdict = inImage || inPdf ? classifyAttachment(mime, Number(stat.size)) : "fits"
      if (verdict === "reject") {
        const warning = oversizedAttachmentNotice({
          label: `"${path.basename(filepath)}" (${mime})`,
          size: Number(stat.size),
          hint: "It was not read.",
        })
        return {
          title,
          output: warning,
          metadata: { preview: warning, truncated: false, loaded: loaded.map((item) => item.filepath) },
        }
      }
      // The active model is carried on ctx.extra.model (set on both the
      // agent-call path and the @file resolution path, which passes messages: []).
      // Fall back to resolving the last user message's model for any caller that
      // doesn't populate extra. Mirrors tool/websearch/index.ts.
      const extraModel = (ctx.extra as { model?: Provider.Model } | undefined)?.model
      const messageModelRef = extraModel
        ? undefined
        : [...ctx.messages]
            .reverse()
            .map((m) => m.info)
            .find((i): i is Extract<typeof i, { role: "user" }> => i.role === "user")?.model
      const model =
        extraModel ??
        (messageModelRef
          ? yield* provider
              .getModel(messageModelRef.providerID, messageModelRef.modelID)
              .pipe(Effect.catchDefect(() => Effect.succeed(undefined)))
          : undefined)

      if (inPdf && !(model?.capabilities.input.pdf ?? false)) {
        // Same shape as the image gate below: the bytes are never read, so a
        // PDF the model cannot take never becomes base64 and never reaches the
        // session DB. The model is pointed at the bundled pdf skill instead.
        const warning = [
          `Cannot attach PDF "${path.basename(filepath)}" — the current model has no PDF input support, so the file was not read.`,
          `To work with its contents, extract text (or render pages to images) with the bundled pdf skill: read ${path.join(builtinSkillRoot(), "pdf-official", "SKILL.md")} and follow it.`,
        ].join("\n")
        return {
          title,
          output: warning,
          metadata: { preview: warning, truncated: false, loaded: loaded.map((item) => item.filepath) },
        }
      }
      if (inImage) {
        const supportsImage = model?.capabilities.input.image ?? false
        if (!supportsImage) {
          const preferred = yield* provider.getVisionModel().pipe(Effect.orElseSucceed(() => undefined))
          const preferredRef = preferred ? `${preferred.providerID}/${preferred.id}` : undefined
          const dispatch = preferredRef
            ? `dispatch a vision-capable subagent: actor run <type> "<desc>" "analyze the image at ${filepath}" --model ${preferredRef} (run \`actor models --vision\` for the full list)`
            : `no vision-capable model is configured — ask the user to configure one or use an OCR tool`
          const warning = [
            `Cannot read image "${path.basename(filepath)}" — the current model has no vision support, so its visual content is unavailable.`,
            `If you need to understand the image visually, ${dispatch}.`,
            `If you instead need the file's raw binary structure, use a shell tool such as \`hexdump -C ${filepath}\` — do not use the read tool for that.`,
          ].join("\n")
          return {
            title,
            output: warning,
            metadata: { preview: warning, truncated: false, loaded: [] as string[] },
          }
        }
        const bytes = Buffer.from(yield* fs.readFile(filepath))
        const fitted = verdict === "shrink" ? shrinkAttachment(mime, bytes) : { mime, base64: bytes.toString("base64") }
        if (!fitted) {
          const warning = oversizedAttachmentNotice({
            label: `"${path.basename(filepath)}" (${mime})`,
            size: bytes.byteLength,
            compressed: true,
            hint: "It was not attached.",
          })
          return {
            title,
            output: warning,
            metadata: { preview: warning, truncated: false, loaded: loaded.map((item) => item.filepath) },
          }
        }
        const output =
          verdict === "shrink"
            ? `Image read successfully (recompressed from ${bytes.byteLength} bytes to ${fitted.mime} to fit the attachment limit)`
            : "Image read successfully"
        return {
          title,
          output,
          metadata: {
            preview: output,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
          },
          attachments: [
            {
              type: "file" as const,
              mime: fitted.mime,
              url: `data:${fitted.mime};base64,${fitted.base64}`,
            },
          ],
        }
      }

      if (inPdf) {
        const bytes = yield* fs.readFile(filepath)
        return {
          title,
          output: "PDF read successfully",
          metadata: {
            preview: "PDF read successfully",
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
          },
          attachments: [
            {
              type: "file" as const,
              mime,
              url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }
      }

      if (inAudio || inVideo) {
        const result = yield* readMedia({ filepath, mime, size: Number(stat.size), kind: inAudio ? "audio" : "video", model })
        return {
          title,
          ...result,
          metadata: { preview: result.output, truncated: false, loaded: loaded.map((item) => item.filepath) },
        }
      }

      if (isBinaryFile(filepath, sample)) {
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      }

      const file = yield* Effect.promise(() =>
        lines(filepath, { limit: params.limit ?? DEFAULT_READ_LIMIT, offset: params.offset ?? 1 }),
      )
      if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
        return yield* Effect.fail(
          new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
        )
      }

      let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
      output += file.raw.map((line, i) => `${i + file.offset}: ${line}`).join("\n")

      const last = file.offset + file.raw.length - 1
      const next = last + 1
      const truncated = file.more || file.cut
      if (file.cut) {
        output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${file.offset}-${last}. Use offset=${next} to continue.)`
      } else if (file.more) {
        output += `\n\n(Showing lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue.)`
      } else {
        output += `\n\n(End of file - total ${file.count} lines)`
      }
      output += "\n</content>"

      yield* warm(filepath)

      if (loaded.length > 0) {
        output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
      }

      return {
        title,
        output,
        metadata: {
          preview: file.raw.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

async function lines(filepath: string, opts: { limit: number; offset: number }) {
  const stream = createReadStream(filepath, { encoding: "utf8" })
  const rl = createInterface({
    input: stream,
    // Note: we use the crlfDelay option to recognize all instances of CR LF
    // ('\r\n') in file as a single line break.
    crlfDelay: Infinity,
  })

  const start = opts.offset - 1
  const raw: string[] = []
  let bytes = 0
  let count = 0
  let cut = false
  let more = false
  try {
    for await (const text of rl) {
      count += 1
      if (count <= start) continue

      if (raw.length >= opts.limit) {
        more = true
        continue
      }

      const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        cut = true
        more = true
        break
      }

      raw.push(line)
      bytes += size
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return { raw, count, cut, more, offset: opts.offset }
}
