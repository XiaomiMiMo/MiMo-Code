import path from "path"
import z from "zod"
import { Effect } from "effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import type { Provider } from "@/provider"
import { Instance } from "@/project/instance"
import { isImageAttachment, sniffAttachmentMime } from "@/util/media"
import { assertExternalDirectoryEffect } from "./external-directory"
import { SessionCwd } from "./session-cwd"
import * as Tool from "./tool"
import DESCRIPTION from "./view-image.txt"

const parameters = z.object({
  path: z.string().describe("Local filesystem path to an image file."),
  detail: z
    .enum(["high", "original"])
    .optional()
    .describe("Image detail level. Defaults to `high`; use `original` to preserve exact resolution."),
})

const SUPPORTED_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

export const ViewImageTool = Tool.define(
  "view_image",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const model = (ctx.extra as { model?: Provider.Model } | undefined)?.model
          if (!model?.capabilities.input.image) {
            return yield* Effect.fail(new Error("view_image is not allowed because you do not support image inputs"))
          }

          const filepath =
            process.platform === "win32"
              ? AppFileSystem.normalizePath(
                  path.isAbsolute(params.path) ? params.path : path.resolve(SessionCwd.get(ctx.sessionID), params.path),
                )
              : path.isAbsolute(params.path)
                ? params.path
                : path.resolve(SessionCwd.get(ctx.sessionID), params.path)
          const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))

          yield* assertExternalDirectoryEffect(ctx, filepath, { kind: "file" })
          yield* ctx.ask({
            permission: "read",
            patterns: [filepath],
            always: ["*"],
            metadata: {},
          })

          if (!stat) {
            return yield* Effect.fail(new Error(`unable to locate image at \`${filepath}\``))
          }
          if (stat.type !== "File") {
            return yield* Effect.fail(new Error(`image path \`${filepath}\` is not a file`))
          }

          const bytes = yield* fs.readFile(filepath)
          const mime = sniffAttachmentMime(bytes.subarray(0, 4096), AppFileSystem.mimeType(filepath))
          if (!isImageAttachment(mime) || !SUPPORTED_MIMES.has(mime)) {
            return yield* Effect.fail(
              new Error(`image path \`${filepath}\` is not a supported JPEG, PNG, GIF, or WebP image`),
            )
          }

          const detail = params.detail ?? "high"
          return {
            title: path.relative(Instance.worktree, filepath),
            output: `Image viewed successfully (${detail} detail)`,
            metadata: { detail },
            attachments: [
              {
                type: "file" as const,
                mime,
                url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
                filename: path.basename(filepath),
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
