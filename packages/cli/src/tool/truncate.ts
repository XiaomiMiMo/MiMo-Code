import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { evaluate } from "@/permission/evaluate"
import { Identifier } from "../id/id"
import { Log } from "../util"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"
import {
  MAX_BYTES,
  MAX_LINES,
  previewToolOutput,
  type PreviewOptions,
  type PreviewResult,
} from "./preview"

export { MAX_BYTES, MAX_LINES, previewToolOutput }
export type { PreviewResult }
export type Options = PreviewOptions

const log = Log.create({ service: "truncation" })
const RETENTION = Duration.days(7)

export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

function hasActorTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("actor", "*", agent.permission).action !== "deny"
}

export function formatToolTruncationHint(file: string, outcome: "success" | "error", agent?: Agent.Info): string {
  const result = outcome === "error" ? "failed" : "succeeded"
  return hasActorTool(agent)
    ? `The tool call ${result} but the output was truncated. Full output saved to: ${file}\nUse the actor tool to have explore agent process this file with \`grep\` and \`read\` (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
    : `The tool call ${result} but the output was truncated. Full output saved to: ${file}\nUse \`grep\` to search the full content or \`read\` with offset/limit to view specific sections.`
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Same preview as `previewToolOutput`; when truncated, writes the full text
   * to the truncation directory and appends the tool-result file-path hint.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Identifier.timestamp(
        Identifier.create("tool", "ascending", Date.now() - Duration.toMillis(RETENTION)),
      )
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        if (Identifier.timestamp(entry) >= cutoff) continue
        yield* fs.remove(path.join(TRUNCATION_DIR, entry)).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const preview = previewToolOutput(text, options)
      if (!preview.truncated) {
        return { content: preview.content, truncated: false } as const
      }
      const file = yield* write(text)
      const hint = formatToolTruncationHint(file, options.outcome ?? "success", agent)
      return {
        content: `${preview.content}\n\n${hint}`,
        truncated: true,
        outputPath: file,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => {
        log.error("truncation cleanup failed", { cause: Cause.pretty(cause) })
        return Effect.void
      }),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(NodePath.layer))
