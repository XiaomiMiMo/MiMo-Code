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

const log = Log.create({ service: "truncation" })
const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

const ERROR_PATTERN = /error|exception|failed|fatal|traceback|panic|exit code/i
const TAIL_SCAN_CHARS = 2048
/** Upper bound for "...N lines/bytes omitted/truncated..." markers so head/tail content + marker ≤ maxBytes. */
const MARKER_RESERVE = 128

/** Take a UTF-8 prefix of `line` that fits in `maxBytes` (single-line giant outputs). */
function sliceLineToBytes(line: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (Buffer.byteLength(line, "utf-8") <= maxBytes) return line
  let end = 0
  let bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf-8")
    if (bytes + n > maxBytes) break
    bytes += n
    end += ch.length
  }
  return line.slice(0, end)
}

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export type PreviewResult = { content: string; truncated: false } | { content: string; truncated: true }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail" | "head+tail"
  pressureCaps?: boolean
  outcome?: "success" | "error"
}

function hasActorTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("actor", "*", agent.permission).action !== "deny"
}

/**
 * Pure tool-result preview. Shared by `Truncate.output` (model-facing tool
 * results) and history FTS extract — same budget and head/tail policy.
 * Does not write files; `Truncate.output` adds the full-output path hint.
 *
 * Omission markers are included in the byte budget (`MARKER_RESERVE`), so
 * returned `content` stays within `maxBytes`.
 */
export function previewToolOutput(text: string, options: Options = {}): PreviewResult {
  let maxLines = options.maxLines ?? MAX_LINES
  let maxBytes = options.maxBytes ?? MAX_BYTES
  const direction = options.direction ?? "head+tail"
  if (options.pressureCaps) {
    maxLines = Math.floor(maxLines / 2)
    maxBytes = Math.floor(maxBytes / 2)
  }

  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false }
  }

  // Content budget leaves room for the truncation/omission marker.
  const contentBytes = Math.max(0, maxBytes - MARKER_RESERVE)

  if (direction === "head+tail") {
    const tailScan = text.length > TAIL_SCAN_CHARS ? text.slice(-TAIL_SCAN_CHARS) : text
    const hasErrors = ERROR_PATTERN.test(tailScan)
    if (hasErrors) {
      const headMaxLines = Math.floor(maxLines * 0.7)
      const headMaxBytes = Math.floor(contentBytes * 0.7)
      const tailMaxLines = maxLines - headMaxLines
      const tailMaxBytes = contentBytes - headMaxBytes
      const headOut: string[] = []
      let headBytes = 0
      for (let i = 0; i < lines.length && headOut.length < headMaxLines; i++) {
        const size = Buffer.byteLength(lines[i]!, "utf-8") + (i > 0 ? 1 : 0)
        if (headBytes + size > headMaxBytes) {
          if (headOut.length === 0 && headMaxBytes > 0) {
            headOut.push(sliceLineToBytes(lines[i]!, headMaxBytes))
            headBytes = Buffer.byteLength(headOut[0]!, "utf-8")
          }
          break
        }
        headOut.push(lines[i]!)
        headBytes += size
      }
      const tailOut: string[] = []
      let tailBytes = 0
      for (let i = lines.length - 1; i >= 0 && tailOut.length < tailMaxLines; i--) {
        const size = Buffer.byteLength(lines[i]!, "utf-8") + (tailOut.length > 0 ? 1 : 0)
        if (tailBytes + size > tailMaxBytes) {
          if (tailOut.length === 0 && tailMaxBytes > 0) {
            const sliced = sliceLineToBytes(lines[i]!, tailMaxBytes)
            tailOut.unshift(sliced.length < lines[i]!.length ? `…${sliced}` : sliced)
            tailBytes = Buffer.byteLength(tailOut[0]!, "utf-8")
          }
          break
        }
        tailOut.unshift(lines[i]!)
        tailBytes += size
      }
      const omitted = lines.length - headOut.length - tailOut.length
      return {
        content: `${headOut.join("\n")}\n\n... ${omitted} lines omitted — showing head and tail ...\n\n${tailOut.join("\n")}`,
        truncated: true,
      }
    }
  }

  const out: string[] = []
  let bytes = 0
  let hitBytes = false
  if (direction === "head" || direction === "head+tail") {
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const size = Buffer.byteLength(lines[i]!, "utf-8") + (i > 0 ? 1 : 0)
      if (bytes + size > contentBytes) {
        // Single-line giants: keep a head slice instead of emitting only the marker.
        if (out.length === 0 && contentBytes > 0) {
          out.push(sliceLineToBytes(lines[i]!, contentBytes))
          bytes = Buffer.byteLength(out[0]!, "utf-8")
        }
        hitBytes = true
        break
      }
      out.push(lines[i]!)
      bytes += size
    }
    const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
    const unit = hitBytes ? "bytes" : "lines"
    return {
      content: `${out.join("\n")}\n\n...${removed} ${unit} truncated...`,
      truncated: true,
    }
  }

  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i]!, "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > contentBytes) {
      if (out.length === 0 && contentBytes > 0) {
        const line = lines[i]!
        const sliced = sliceLineToBytes(line, contentBytes)
        out.unshift(sliced.length < line.length ? `…${sliced}` : sliced)
        bytes = Buffer.byteLength(out[0]!, "utf-8")
      }
      hitBytes = true
      break
    }
    out.unshift(lines[i]!)
    bytes += size
  }
  const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
  const unit = hitBytes ? "bytes" : "lines"
  return {
    content: `...${removed} ${unit} truncated...\n\n${out.join("\n")}`,
    truncated: true,
  }
}

export function formatToolTruncationHint(file: string, outcome: "success" | "error", agent?: Agent.Info): string {
  const result = outcome === "error" ? "failed" : "succeeded"
  return hasActorTool(agent)
    ? `The tool call ${result} but the output was truncated. Full output saved to: ${file}\nUse the actor tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
    : `The tool call ${result} but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
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
