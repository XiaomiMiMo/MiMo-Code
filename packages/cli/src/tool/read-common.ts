import { Effect } from "effect"
import * as path from "path"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { SessionCwd } from "./session-cwd"
import type * as Tool from "./tool"

/** Resolves a tool's `file_path` against the session cwd, as every read-family tool does. */
export function resolveFilePath(filePath: string, ctx: Tool.Context) {
  const filepath = path.isAbsolute(filePath) ? filePath : path.resolve(SessionCwd.get(ctx.sessionID), filePath)
  return process.platform === "win32" ? AppFileSystem.normalizePath(filepath) : filepath
}

/** The not-found failure, with up to three similarly named siblings as suggestions. */
export const missingFile = Effect.fn("ReadCommon.missingFile")(function* (
  fs: AppFileSystem.Interface,
  filepath: string,
) {
  const dir = path.dirname(filepath)
  const base = path.basename(filepath)
  const items = yield* fs.readDirectory(dir).pipe(
    Effect.map((items) =>
      items
        .filter(
          (item) => item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
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
