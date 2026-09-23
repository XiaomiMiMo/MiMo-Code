import path from "path"
import z from "zod"
import { Effect, Option } from "effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { ModelCapability, Provider } from "@/provider"
import { Instance } from "@/project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import { SessionCwd } from "./session-cwd"
import * as Tool from "./tool"
import {
  fitsMediaBase64,
  oversizedMediaNotice,
  READ_AUDIO_MIMES,
  READ_VIDEO_MIMES,
  sniffAttachmentMime,
} from "@/util/media"

// Shared by read, read_video, and listen_audio so capability and encoded-size gates stay aligned.
export const ReadMedia = Effect.gen(function* () {
  const fs = yield* AppFileSystem.Service

  return Effect.fn("ReadMedia")(function* (input: {
    filepath: string
    mime: string
    size: number
    kind: "audio" | "video"
    model: Provider.Model | undefined
  }) {
    if (!input.model?.capabilities.input[input.kind]) {
      return {
        output: [
          `Cannot attach ${input.kind} "${path.basename(input.filepath)}" — the current model has no ${input.kind} input support, so the file was not read.`,
          `Ask the user to switch to a model with ${input.kind} input, or use a shell tool (e.g. ffprobe) to inspect its metadata instead.`,
        ].join("\n"),
      }
    }

    const declared = ModelCapability.modelDeclaration(input.model, input.kind)
    if (declared.support === "supported" && declared.mimeTypes !== "any" && !declared.mimeTypes.includes(input.mime)) {
      return {
        output: [
          `Cannot attach ${input.kind} "${path.basename(input.filepath)}" (${input.mime}) — the current provider only accepts ${declared.mimeTypes.join(", ")}, so the file was not read.`,
          `Convert it first (e.g. ffmpeg -i "${input.filepath}" /tmp/example.${input.kind === "audio" ? "wav" : "mp4"}) and read the converted file.`,
        ].join("\n"),
      }
    }

    // Check the encoded size before reading or allocating the full payload.
    if (!fitsMediaBase64(input.size)) {
      return {
        output: oversizedMediaNotice({
          label: `"${path.basename(input.filepath)}" (${input.mime})`,
          size: input.size,
          hint: "It was not read.",
        }),
      }
    }

    const bytes = yield* fs.readFile(input.filepath)
    return {
      output: `${input.kind === "audio" ? "Audio" : "Video"} read successfully and attached for the model to analyze`,
      attachments: [
        {
          type: "file" as const,
          mime: input.mime,
          filename: path.basename(input.filepath),
          url: `data:${input.mime};base64,${Buffer.from(bytes).toString("base64")}`,
        },
      ],
    }
  })
})

export function defineMediaReader(id: string, kind: "audio" | "video", description: string) {
  const parameters = z.object({
    path: z
      .string()
      .describe(kind === "audio" ? "Path to a local WAV or MP3 audio file." : "Path to a local MP4 video file."),
  })
  const mimes = kind === "audio" ? READ_AUDIO_MIMES : READ_VIDEO_MIMES

  return Tool.define(
    id,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const provider = yield* Provider.Service
      const readMedia = yield* ReadMedia

      return {
        description,
        parameters,
        execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
          Effect.gen(function* () {
            const filepath = AppFileSystem.normalizePath(path.resolve(SessionCwd.get(ctx.sessionID), params.path))
            const title = path.relative(Instance.worktree, filepath)
            const stat = yield* fs.stat(filepath).pipe(
              Effect.catchIf(
                (err) => "reason" in err && err.reason._tag === "NotFound",
                () => Effect.succeed(undefined),
              ),
            )

            yield* assertExternalDirectoryEffect(ctx, filepath, {
              kind: stat?.type === "Directory" ? "directory" : "file",
            })
            yield* ctx.ask({ permission: "read", patterns: [filepath], always: ["*"], metadata: {} })
            if (!stat) return yield* Effect.fail(new Error(`File not found: ${filepath}`))
            if (stat.type !== "File") return yield* Effect.fail(new Error(`Media path \`${filepath}\` is not a file`))

            const sample = yield* Effect.scoped(
              Effect.gen(function* () {
                const file = yield* fs.open(filepath, { flag: "r" })
                return Option.getOrElse(yield* file.readAlloc(4096), () => new Uint8Array())
              }),
            )
            const mime = sniffAttachmentMime(sample, AppFileSystem.mimeType(filepath))
            if (!mimes.has(mime)) {
              return {
                title,
                output: [
                  `Cannot attach ${kind} "${path.basename(filepath)}" (${mime}) — ${id} only attaches ${[...mimes].join(", ")}, so the file was not read.`,
                  `Convert it first (e.g. ffmpeg -i "${filepath}" /tmp/example.${kind === "audio" ? "wav" : "mp4"}) and read the converted file.`,
                ].join("\n"),
                metadata: { truncated: false },
              }
            }

            const extraModel = ctx.extra?.model as Provider.Model | undefined
            const ref = extraModel
              ? undefined
              : ctx.messages.map((message) => message.info).findLast((info) => info.role === "user")?.model
            const model =
              extraModel ??
              (ref
                ? yield* provider
                    .getModel(ref.providerID, ref.modelID)
                    .pipe(Effect.catchDefect(() => Effect.succeed(undefined)))
                : undefined)
            const result = yield* readMedia({ filepath, mime, size: Number(stat.size), kind, model })
            return { title, ...result, metadata: { truncated: false } }
          }).pipe(Effect.orDie),
      }
    }),
  )
}
