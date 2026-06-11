import path from "path"
import z from "zod"
import { Effect } from "effect"
import { InstanceState } from "@/effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Bus } from "@/bus"
import { assertExternalDirectoryEffect } from "./external-directory"
import { SessionCwd } from "./session-cwd"
import * as Tool from "./tool"

const DESCRIPTION = [
  "Switch the working directory for the current session (like cd in a terminal).",
  "",
  "Use this when the user asks to switch, change, or cd into a directory,",
  "or when you need to work extensively within a subdirectory (e.g., a monorepo package).",
  "",
  "After calling this tool, all subsequent file operations (read, edit, write, glob, grep, bash)",
  "will resolve relative paths from the new directory. Subagents inherit the changed directory.",
  "",
  "Pass an absolute path, or a relative path (resolved from the current working directory).",
  'Pass "~" to reset back to the project root.',
].join("\n")

export const ChangeDirectoryTool = Tool.define(
  "change_directory",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        path: z
          .string()
          .describe(
            "The directory to switch to. Absolute or relative to current working directory. Use '~' to reset to project root.",
          ),
      }),
      execute: (params: { path: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const currentCwd = SessionCwd.get(ctx.sessionID)

          if (params.path === "~" || params.path === "") {
            SessionCwd.clear(ctx.sessionID)
            yield* bus.publish(SessionCwd.Event.Changed, {
              sessionID: ctx.sessionID,
              cwd: ins.directory,
            })
            return {
              title: "reset",
              metadata: { from: currentCwd, to: ins.directory },
              output: `Working directory reset to project root: ${ins.directory}`,
            }
          }

          const resolved = path.isAbsolute(params.path)
            ? params.path
            : path.resolve(currentCwd, params.path)

          const normalized = path.normalize(resolved)

          const stat = yield* fs.stat(normalized).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )

          if (!stat) {
            throw new Error(`Directory does not exist: ${normalized}`)
          }

          if (stat.type !== "Directory") {
            throw new Error(`Path is not a directory: ${normalized}`)
          }

          yield* assertExternalDirectoryEffect(ctx, normalized, { kind: "directory" })

          SessionCwd.set(ctx.sessionID, normalized)
          yield* bus.publish(SessionCwd.Event.Changed, {
            sessionID: ctx.sessionID,
            cwd: normalized,
          })

          return {
            title: path.relative(ins.worktree, normalized) || ".",
            metadata: { from: currentCwd, to: normalized },
            output: `Working directory changed: ${currentCwd} → ${normalized}`,
          }
        }),
    }
  }),
)
