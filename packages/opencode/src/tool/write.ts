import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { Config } from "../config"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"
import { normalizeLineEndings, trimDiff } from "./edit"
import { assertWriteAllowed, askEditUnlessMemory } from "./external-directory"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const format = yield* Format.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        content: z.string().describe("The content to write to the file"),
        filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
      }),
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(SessionCwd.get(ctx.sessionID), params.filePath)
          yield* assertWriteAllowed(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          const contentOld = exists ? yield* fs.readFileString(filepath) : ""

          if (exists && (yield* config.get()).autoRefreshFiles) {
            const diskContent = yield* fs.readFileString(filepath)
            if (normalizeLineEndings(diskContent) !== normalizeLineEndings(params.content)) {
              return {
                title: path.relative(Instance.worktree, filepath),
                metadata: { diagnostics: {}, filepath, exists },
                output: `<system-reminder>文件 ${filepath} 已被外部修改，磁盘内容与你预期的不一致。请使用 read 工具重新读取文件后，基于最新内容重新生成写入内容。</system-reminder>`,
              }
            }
          }

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
          yield* askEditUnlessMemory(ctx, filepath, {
            patterns: [path.relative(Instance.worktree, filepath)],
            diff,
          })

          yield* fs.writeWithDirs(filepath, params.content)
          yield* format.file(filepath)
          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, true)
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = AppFileSystem.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(Instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
