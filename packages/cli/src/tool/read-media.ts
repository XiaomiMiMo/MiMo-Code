import z from "zod"
import { Effect, Option } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import { missingFile, resolveFilePath } from "./read-common"
import { ModelCapability, Provider } from "@/provider"
import { shrinkAttachment } from "@/provider/image"
import {
  classifyAttachment,
  fitsMediaBase64,
  oversizedAttachmentNotice,
  oversizedMediaNotice,
  READ_AUDIO_MIMES,
  READ_IMAGE_MIMES,
  READ_VIDEO_MIMES,
  sniffAttachmentMime,
} from "@/util/media"
import IMAGE_DESCRIPTION from "./read-image.txt"
import AUDIO_DESCRIPTION from "./read-audio.txt"
import VIDEO_DESCRIPTION from "./read-video.txt"
import { MEDIA_TOOL_IDS, type MediaKind } from "./media-kind"

const SAMPLE_BYTES = 4096

const KINDS = {
  image: { mimes: READ_IMAGE_MIMES, convertExt: "png", description: IMAGE_DESCRIPTION },
  audio: { mimes: READ_AUDIO_MIMES, convertExt: "wav", description: AUDIO_DESCRIPTION },
  video: { mimes: READ_VIDEO_MIMES, convertExt: "mp4", description: VIDEO_DESCRIPTION },
} as const satisfies Record<MediaKind, { mimes: ReadonlySet<string>; convertExt: string; description: string }>

/**
 * Whether `model`, through the adapter it runs on, accepts `kind` input. An
 * adapter verdict of `unknown` counts as unsupported (fail closed), and an
 * unresolved model supports nothing.
 */
export function supportsMedia(model: Provider.Model | undefined, kind: MediaKind) {
  if (!model) return false
  return ModelCapability.modelDeclaration(model, kind).support === "supported"
}

const parameters = z.object({
  file_path: z.string().describe("Path to the file"),
})

function define<ID extends string>(id: ID, kind: MediaKind) {
  const spec = KINDS[kind]
  const label = kind === "image" ? "Image" : kind === "audio" ? "Audio" : "Video"

  return Tool.define(
    id,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const provider = yield* Provider.Service

      // The active model is carried on ctx.extra.model. Fall back to the last
      // user message's model for any caller that doesn't populate extra.
      const resolveModel = Effect.fn(`${label}Read.model`)(function* (ctx: Tool.Context) {
        const extraModel = (ctx.extra as { model?: Provider.Model } | undefined)?.model
        if (extraModel) return extraModel
        const ref = [...ctx.messages]
          .reverse()
          .map((m) => m.info)
          .find((i): i is Extract<typeof i, { role: "user" }> => i.role === "user")?.model
        if (!ref) return undefined
        return yield* provider.getModel(ref.providerID, ref.modelID).pipe(Effect.catchDefect(() => Effect.succeed(undefined)))
      })

      const readSample = Effect.fn(`${label}Read.sample`)(function* (filepath: string, fileSize: number) {
        if (fileSize === 0) return new Uint8Array()
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(filepath, { flag: "r" })
            return Option.getOrElse(yield* file.readAlloc(Math.min(SAMPLE_BYTES, fileSize)), () => new Uint8Array())
          }),
        )
      })

      const unsupported = Effect.fn(`${label}Read.unsupported`)(function* (filepath: string) {
        const name = path.basename(filepath)
        if (kind !== "image") {
          return [
            `Cannot attach ${kind} "${name}" — the current model has no ${kind} input support through its provider, so the file was not read.`,
            `Ask the user to switch to a model with ${kind} input, or use a shell tool (e.g. ffprobe) to inspect its metadata instead.`,
          ].join("\n")
        }
        const preferred = yield* provider.getVisionModel().pipe(Effect.orElseSucceed(() => undefined))
        const preferredRef = preferred ? `${preferred.providerID}/${preferred.id}` : undefined
        const dispatch = preferredRef
          ? `dispatch a vision-capable subagent: actor run <type> "<desc>" "analyze the image at ${filepath}" --model ${preferredRef} (run \`actor models --vision\` for the full list)`
          : `no vision-capable model is configured — ask the user to configure one or use an OCR tool`
        return [
          `Cannot read image "${name}" — the current model has no vision support, so its visual content is unavailable.`,
          `If you need to understand the image visually, ${dispatch}.`,
          `If you instead need the file's raw binary structure, use a shell tool such as \`hexdump -C ${filepath}\`.`,
        ].join("\n")
      })

      const run = Effect.fn(`${label}Read.execute`)(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
        const filepath = resolveFilePath(params.file_path, ctx)
        const title = path.relative(Instance.worktree, filepath)
        const notice = (output: string) => ({ title, output, metadata: { preview: output, truncated: false } })

        // Re-check the gate the registry applied: a stale tool list or a direct
        // caller must not attach bytes the model cannot take. Nothing is read.
        const model = yield* resolveModel(ctx)
        if (!model || !supportsMedia(model, kind)) return notice(yield* unsupported(filepath))

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

        if (!stat) return yield* missingFile(fs, filepath)
        if (stat.type === "Directory") {
          return yield* Effect.fail(new Error(`Path is a directory, not ${kind === "image" ? "an" : "a"} ${kind} file: ${filepath}`))
        }

        const size = Number(stat.size)
        const sample = yield* readSample(filepath, size)
        const mime = sniffAttachmentMime(sample, AppFileSystem.mimeType(filepath))
        const name = path.basename(filepath)
        const convert = `Convert it first (e.g. ffmpeg -i "${filepath}" /tmp/example.${spec.convertExt}) and read the converted file.`

        // Finite allowlist only: mime-types maps code extensions such as .ts to
        // video/mp2t, so prefix matching must not decide an attach.
        if (!spec.mimes.has(mime)) {
          return notice(
            [
              `Cannot attach ${kind} "${name}" (${mime}) — ${id} only accepts ${[...spec.mimes].join(", ")}, so the file was not read.`,
              convert,
            ].join("\n"),
          )
        }

        // The adapter declaration can narrow the allowlist further (rare);
        // refuse rather than attach bytes tool-attachment.ts would later replace
        // with a placeholder.
        const declared = ModelCapability.modelDeclaration(model, kind)
        if (declared.mimeTypes !== "any" && !declared.mimeTypes.includes(mime)) {
          return notice(
            [
              `Cannot attach ${kind} "${name}" (${mime}) — the current provider only accepts ${declared.mimeTypes.join(", ")}, so the file was not read.`,
              convert,
            ].join("\n"),
          )
        }

        if (kind === "image") {
          // Size gate on stat, before any bytes are read (see classifyAttachment):
          // a rejected image is never read, an oversized one within the source
          // ceiling is read and recompressed below.
          const verdict = classifyAttachment(mime, size)
          if (verdict === "reject") {
            return notice(oversizedAttachmentNotice({ label: `"${name}" (${mime})`, size, hint: "It was not read." }))
          }
          const bytes = Buffer.from(yield* fs.readFile(filepath))
          const fitted = verdict === "shrink" ? shrinkAttachment(mime, bytes) : { mime, base64: bytes.toString("base64") }
          if (!fitted) {
            return notice(
              oversizedAttachmentNotice({
                label: `"${name}" (${mime})`,
                size: bytes.byteLength,
                compressed: true,
                hint: "It was not attached.",
              }),
            )
          }
          const output =
            verdict === "shrink"
              ? `Image read successfully (recompressed from ${bytes.byteLength} bytes to ${fitted.mime} to fit the attachment limit)`
              : "Image read successfully"
          return {
            ...notice(output),
            attachments: [{ type: "file" as const, mime: fitted.mime, url: `data:${fitted.mime};base64,${fitted.base64}` }],
          }
        }

        // The provider bounds the ENCODED size of audio and video, so the gate
        // is on base64 length, checked on stat before any bytes are read.
        if (!fitsMediaBase64(size)) {
          return notice(oversizedMediaNotice({ label: `"${name}" (${mime})`, size, hint: "It was not read." }))
        }
        const bytes = yield* fs.readFile(filepath)
        return {
          ...notice(`${label} read successfully and attached for the model to analyze`),
          attachments: [
            {
              type: "file" as const,
              mime,
              filename: name,
              url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }
      })

      return {
        description: spec.description,
        parameters,
        execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
      }
    }),
  )
}

export const ReadImageTool = define(MEDIA_TOOL_IDS.image, "image")
export const ReadAudioTool = define(MEDIA_TOOL_IDS.audio, "audio")
export const ReadVideoTool = define(MEDIA_TOOL_IDS.video, "video")
