import path from "path"
import type { MessageV2 } from "./message-v2"
import { isRecord } from "@/util/record"

export const TRY_BEST_EDIT_WINDOW = 12
export const TRY_BEST_EDIT_SIMILARITY = 0.8
export const TRY_BEST_EDIT_MATCHES = 2
export const TRY_BEST_ACTION_STREAK = 4
export const TRY_BEST_BASH_RETRIES = 3

export type TryBestReason = "edit_repeat" | "bash_retry" | "action_streak"

export type TryBestEvidence = {
  tool: string
  path?: string
  command?: string
  count: number
  similarity?: number
  action?: "edit" | "verify"
}

export type TryBestIncident = {
  reason: TryBestReason
  evidence: TryBestEvidence
}

export type TryBestOptions = {
  edit_window?: number
  edit_similarity?: number
  edit_matches?: number
  action_streak?: number
}

type EditEvent = {
  path: string
  shingles: ReadonlySet<string>
}

type Action = {
  kind: "edit" | "verify"
  progress: boolean
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit", "notebook_edit", "str_replace"])
const VERIFY_COMMAND =
  /(?:^|[;&|]\s*|\s)(?:bun\s+(?:test|typecheck|run\s+(?:test|typecheck|lint|build))|npm\s+(?:test|run\s+(?:test|typecheck|lint|build))|pnpm\s+(?:test|run\s+(?:test|typecheck|lint|build))|yarn\s+(?:test|run\s+(?:test|typecheck|lint|build))|pytest\b|python(?:3)?\s+-m\s+pytest\b|cargo\s+(?:test|check|clippy|build)\b|go\s+test\b|make\s+(?:test|check|lint|build)\b|tsc\b)/i

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function inputPath(part: MessageV2.ToolPart) {
  return text(part.state.input.file_path) ?? text(part.state.input.path) ?? text(part.state.input.notebook_path)
}

function metadata(part: MessageV2.ToolPart) {
  if (part.state.status !== "completed") return undefined
  return part.state.metadata
}

function editRecords(part: MessageV2.ToolPart): { path: string; diff: string }[] {
  const meta = metadata(part)
  if (!meta) return []
  if (part.tool === "apply_patch" && Array.isArray(meta.files)) {
    return meta.files.flatMap((value) => {
      if (!isRecord(value)) return []
      const filePath = text(value.filePath) ?? text(value.relativePath)
      const diff = text(value.patch)
      return filePath && diff ? [{ path: filePath, diff }] : []
    })
  }
  if (part.tool === "multiedit" && Array.isArray(meta.results)) {
    const filePath = inputPath(part)
    if (!filePath) return []
    const diff = meta.results
      .flatMap((value) => (isRecord(value) && typeof value.diff === "string" ? [value.diff] : []))
      .join("\n")
    return diff ? [{ path: filePath, diff }] : []
  }
  const filePath =
    inputPath(part) ?? text(meta.filepath) ?? (isRecord(meta.filediff) ? text(meta.filediff.file) : undefined)
  const diff = text(meta.diff)
  return filePath && diff ? [{ path: filePath, diff }] : []
}

export function normalizeDiff(diff: string) {
  return diff
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter(
      (line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"),
    )
    .map((line) => `${line[0]} ${line.slice(1).trim().replace(/\s+/g, " ")}`)
    .filter((line) => line.length > 2)
    .join(" ")
}

export function shingleSet(value: string, size = 3) {
  const tokens = value.split(/\s+/).filter(Boolean)
  if (tokens.length < size) return new Set(tokens.length ? [tokens.join("\0")] : [])
  return new Set(
    tokens.slice(0, tokens.length - size + 1).map((_, index) => tokens.slice(index, index + size).join("\0")),
  )
}

export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  const union = new Set([...left, ...right])
  if (union.size === 0) return 0
  return [...left].filter((value) => right.has(value)).length / union.size
}

export function normalizeCommand(command: string) {
  return command
    .replace(/(?:\/private)?\/tmp\/[\w.-]+/g, "<TMP>")
    .replace(/\b\d{6,}\b/g, "<NUM>")
    .replace(/--seed(?:=|\s+)\S+/g, "<SEED>")
    .replace(/\s+/g, " ")
    .trim()
}

export function normalizeResult(value: string) {
  const normalized = value
    .replace(/(?:\/private)?\/tmp\/[\w./-]+/g, "<TMP>")
    .replace(/\b\d{6,}\b/g, "<NUM>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|sec|seconds?)\b/gi, "<TIME>")
    .replace(/\s+/g, " ")
    .trim()
  if (normalized.length <= 2000) return normalized
  const marker = " <TRUNCATED> "
  const head = Math.ceil((2000 - marker.length) / 2)
  return `${normalized.slice(0, head)}${marker}${normalized.slice(-(2000 - marker.length - head))}`
}

function command(part: MessageV2.ToolPart) {
  return text(part.state.input.command) ?? text(part.state.input.cmd)
}

export class TryBestMonitor {
  private edits: EditEvent[] = []
  private failed = new Map<string, number>()
  private action: Action | undefined
  private streak = 0
  private verify = new Map<string, { success: boolean; result: string }>()

  constructor(private options: TryBestOptions = {}) {}

  configure(options: TryBestOptions = {}) {
    this.options = options
  }

  consume(part: MessageV2.ToolPart): TryBestIncident | undefined {
    if (part.state.status === "pending" || part.state.status === "running") return undefined
    if (EDIT_TOOLS.has(part.tool)) return this.edit(part)
    if (part.tool !== "bash") return undefined
    return this.bash(part)
  }

  reset() {
    this.edits = []
    this.failed.clear()
    this.verify.clear()
    this.resetAction()
  }

  private edit(part: MessageV2.ToolPart): TryBestIncident | undefined {
    if (part.state.status !== "completed") return this.trackAction({ kind: "edit", progress: false }, part.tool)
    this.failed.clear()
    const records = editRecords(part)
    const incident = records.flatMap((record) => {
      const normalized = normalizeDiff(record.diff)
      if (!normalized) return []
      const shingles = shingleSet(normalized)
      const matches = this.edits
        .filter((event) => event.path === path.normalize(record.path))
        .map((event) => jaccard(shingles, event.shingles))
        .filter(
          (similarity) =>
            similarity > Math.min(Math.max(this.options.edit_similarity ?? TRY_BEST_EDIT_SIMILARITY, 0), 1),
        )
      this.edits.push({ path: path.normalize(record.path), shingles })
      if (this.edits.length > (this.options.edit_window ?? TRY_BEST_EDIT_WINDOW)) this.edits.shift()
      if (matches.length < (this.options.edit_matches ?? TRY_BEST_EDIT_MATCHES)) return []
      return [
        {
          reason: "edit_repeat" as const,
          evidence: {
            tool: part.tool,
            path: record.path,
            count: matches.length + 1,
            similarity: Math.max(...matches),
          },
        },
      ]
    })[0]
    return incident ?? this.trackAction({ kind: "edit", progress: false }, part.tool)
  }

  private bash(part: MessageV2.ToolPart): TryBestIncident | undefined {
    if (part.state.status === "pending" || part.state.status === "running") return undefined
    const raw = command(part)
    if (!raw) {
      this.resetAction()
      return undefined
    }
    const normalized = normalizeCommand(raw)
    const meta = metadata(part)
    const success = part.state.status === "completed" && (!(meta && "exit" in meta) || meta.exit === 0)
    const result = normalizeResult(part.state.status === "completed" ? part.state.output : part.state.error)
    const verifying = VERIFY_COMMAND.test(normalized)
    const previous = verifying ? this.verify.get(normalized) : undefined
    const progress = success || (!!previous && previous.result !== result)
    if (verifying) this.verify.set(normalized, { success, result })
    const count = !success ? (progress ? 1 : (this.failed.get(normalized) ?? 0) + 1) : 0
    if (!success) this.failed.set(normalized, count)
    if (success) this.failed.delete(normalized)
    const retry =
      count >= TRY_BEST_BASH_RETRIES
        ? { reason: "bash_retry" as const, evidence: { tool: part.tool, command: normalized, count } }
        : undefined
    if (!verifying) return retry
    const action = this.trackAction({ kind: "verify", progress }, part.tool, normalized)
    return retry ?? action
  }

  private trackAction(next: Action, tool: string, command?: string): TryBestIncident | undefined {
    if (next.progress || this.action?.kind !== next.kind) {
      this.action = next
      this.streak = next.progress ? 0 : 1
      return undefined
    }
    this.streak++
    if (this.streak < (this.options.action_streak ?? TRY_BEST_ACTION_STREAK)) return undefined
    return {
      reason: "action_streak" as const,
      evidence: { tool, command, count: this.streak, action: next.kind },
    }
  }

  private resetAction() {
    this.action = undefined
    this.streak = 0
  }
}

const monitors = new Map<string, TryBestMonitor>()

export function monitor(sessionID: string, agentID?: string, options?: TryBestOptions) {
  const key = `${sessionID}:${agentID ?? "main"}`
  const hit = monitors.get(key)
  if (hit) {
    hit.configure(options)
    return hit
  }
  const next = new TryBestMonitor(options)
  monitors.set(key, next)
  return next
}

export function resetMonitor(sessionID: string, agentID?: string) {
  monitors.delete(`${sessionID}:${agentID ?? "main"}`)
}

export function resetAllMonitors() {
  monitors.clear()
}
