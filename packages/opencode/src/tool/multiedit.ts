import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { EditTool } from "./edit"
import DESCRIPTION from "./multiedit.txt"
import path from "path"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"

const EditEntry = z.object({
  old_string: z.string().describe("The text to replace"),
  new_string: z.string().describe("The text to replace it with (must be different from old_string)"),
  replace_all: z.boolean().optional().describe("Replace all occurrences of old_string (default false)"),
})

const Parameters = z.object({
  file_path: z.string().describe("Path to the file to modify"),
  edits: z.array(EditEntry).describe("Array of edit operations to perform sequentially on the file"),
})

export const MultiEditTool = Tool.define(
  "multiedit",
  Effect.gen(function* () {
    const editInfo = yield* EditTool
    const edit = yield* editInfo.init()

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const filePath = path.isAbsolute(params.file_path)
            ? params.file_path
            : path.resolve(SessionCwd.get(ctx.sessionID), params.file_path)
          const results = []
          for (const [, entry] of params.edits.entries()) {
            const result = yield* edit.execute(
              {
                file_path: filePath,
                old_string: entry.old_string,
                new_string: entry.new_string,
                replace_all: entry.replace_all,
              },
              ctx,
            )
            results.push(result)
          }
          return {
            title: path.relative(Instance.worktree, filePath),
            metadata: {
              results: results.map((r) => r.metadata),
            },
            output: results.at(-1)!.output,
          }
        }),
    }
  }),
)
