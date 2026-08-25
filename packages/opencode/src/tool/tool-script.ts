import z from "zod"
import os from "os"
import fs from "fs"
import path from "path"
import ts from "typescript"
import { Effect } from "effect"
import type { Tool as AiTool } from "ai"
import { EffectBridge, InstanceState } from "@/effect"
import { Log, Filesystem, ToolCompat } from "@/util"
import { Agent } from "@/agent/agent"
import type { ModelID, ProviderID } from "../provider/schema"
import { MessageV2 } from "../session/message-v2"
import { evalScript, type HostFn } from "../workflow/sandbox"
import { toolScriptRegistry, TOOL_SCRIPT_ALIASES, TOOL_SCRIPT_EXCLUDED } from "./tool-script-ref"
import type { HarnessMode } from "./gpt"
import DESCRIPTION from "./tool-script.txt"
import * as Tool from "./tool"
import { getToolResultAttachments, getToolResultMetadata } from "./result-error"
import { isRecoverableError } from "./recoverable"
import * as Truncate from "./truncate"

const log = Log.create({ service: "tool.exec" })

const MAX_TOOL_CALLS_DEFAULT = 50
const MAX_TOOL_CALLS_CEILING = 500
const MAX_CONCURRENT = 8
const ACTIVE_DEADLINE_MS_DEFAULT = 60_000
const ACTIVE_DEADLINE_MS_CEILING = 600_000
const WALL_DEADLINE_MS = 30 * 60 * 1000
const MAX_RESULT_BYTES = 256 * 1024
const MAX_LOG_BYTES = 64 * 1024
const MAX_CODE_BYTES = 128 * 1024
const MAX_FILE_BYTES = 10 * 1024 * 1024
const EXEC_PROGRESS_DEBOUNCE_MS = 150
const TRACE_TAIL_ENTRIES = 20
const EXEC_COMMAND_DEFAULT_YIELD_TIME_MS = 10_000
const EXEC_COMMAND_DEFAULT_MAX_OUTPUT_TOKENS = 10_000

const ExecCommandParameters = z.object({
  cmd: z.string().describe("Shell command to execute."),
  yield_time_ms: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Wait budget in milliseconds before the command is terminated. Defaults to ${EXEC_COMMAND_DEFAULT_YIELD_TIME_MS} ms.`,
    ),
  max_output_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Output token budget. Defaults to ${EXEC_COMMAND_DEFAULT_MAX_OUTPUT_TOKENS} tokens.`),
  workdir: z
    .string()
    .optional()
    .describe("Working directory for the command."),
  description: z.string().optional().describe("Short description of what the command does when provided."),
})

const EXEC_COMMAND_DESCRIPTION =
  "Runs a shell command through the permission-gated bash executor. `workdir` defaults to the current session directory. If provided, prefer an absolute path. Avoid using `cd <directory> && <command>` to select the initial directory."

function levenshtein(a: string, b: string): number {
  const distances = Array.from({ length: a.length + 1 }, (_, index) =>
    Array.from({ length: b.length + 1 }, (__, inner) => (index === 0 ? inner : inner === 0 ? index : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      distances[i][j] = Math.min(
        distances[i - 1][j] + 1,
        distances[i][j - 1] + 1,
        distances[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return distances[a.length][b.length]
}

function execCommandArgs(args: unknown) {
  const keys = ["cmd", "yield_time_ms", "max_output_tokens", "workdir", "description"]
  const repaired =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.fromEntries(
          Object.entries(args).map(([key, value]) => {
            if (keys.includes(key)) return [key, value]
            const canonical = keys.filter((candidate) => ToolCompat.canonical(key) === ToolCompat.canonical(candidate))
            const matches = canonical.length
              ? canonical
              : keys.filter(
                  (candidate) =>
                    ToolCompat.canonical(candidate).length >= 5 &&
                    levenshtein(ToolCompat.canonical(key), ToolCompat.canonical(candidate)) === 1,
                )
            if (matches.length !== 1 || matches[0] in args) return [key, value]
            return [matches[0], value]
          }),
        )
      : args
  const input = ExecCommandParameters.parse(repaired)
  return {
    command: input.cmd,
    timeout: input.yield_time_ms ?? EXEC_COMMAND_DEFAULT_YIELD_TIME_MS,
    max_output_tokens: input.max_output_tokens ?? EXEC_COMMAND_DEFAULT_MAX_OUTPUT_TOKENS,
    workdir: input.workdir,
    description: (() => {
      const description = input.description ?? input.cmd
      return description.length > 80 ? `${description.slice(0, 77)}...` : description
    })(),
  }
}

function normalizeExecCode(code: string) {
  return code
    .replace(/^(\s*)<(?:parameter|paramter)(?:(?:\s+name\s*=|\s*=)\s*["']?code["']?)?\s*>\s*/i, "$1")
    .replace(/^(\s*)<(?=(?:const|let|var)\b)/, "$1")
    .replace(/(?:\s*<\/(?:parameter|paramter)>)+\s*(?:#{1,6}\s*)?$/i, "")
}

/** JSON Schema (zod v4 toJSONSchema output) → compact TS type text. Best-effort:
 * anything unrecognized renders as `unknown`, which is safe for declarations. */
function schemaToTs(schema: any): string {
  if (!schema || typeof schema !== "object") return "unknown"
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ")
  const variants = schema.anyOf ?? schema.oneOf
  if (variants) return variants.map(schemaToTs).join(" | ")
  switch (schema.type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array":
      return `Array<${schemaToTs(schema.items)}>`
    case "object": {
      if (!schema.properties) {
        if (schema.additionalProperties && typeof schema.additionalProperties === "object")
          return `Record<string, ${schemaToTs(schema.additionalProperties)}>`
        return "Record<string, unknown>"
      }
      const required = new Set<string>(schema.required ?? [])
      const fields = Object.entries(schema.properties).map(
        ([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${schemaToTs(value)}`,
      )
      return `{ ${fields.join("; ")} }`
    }
    default:
      return "unknown"
  }
}

/** Render the `tools` API declaration block appended to the tool description. */
export function renderToolScriptDeclarations(defs: Tool.Def[]): string {
  const aliases = new Set(Object.keys(TOOL_SCRIPT_ALIASES))
  const aliasTargets = new Set<string>(Object.values(TOOL_SCRIPT_ALIASES))
  const lines = defs
    .filter(
      (def) => !TOOL_SCRIPT_EXCLUDED.has(def.id) && !aliases.has(def.id) && !aliasTargets.has(def.id),
    )
    .map((def) => {
      const summary = def.description.split("\n").find((l) => l.trim()) ?? ""
      const input = schemaToTs(z.toJSONSchema(def.parameters))
      return `  /** ${summary.trim().slice(0, 200)} */\n  ${def.id}(input: ${input}): Promise<ToolResult>`
    })
  const aliasLines = Object.entries(TOOL_SCRIPT_ALIASES).flatMap(([alias, target]) => {
    const def = defs.find((item) => item.id === target)
    if (!def) return []
    const summary = alias === "exec_command"
      ? EXEC_COMMAND_DESCRIPTION
      : def.description.split("\n").find((line) => line.trim()) ?? ""
    const input = schemaToTs(z.toJSONSchema(alias === "exec_command" ? ExecCommandParameters : def.parameters))
    return [`  /** Alias for ${target}. ${summary.trim().slice(0, 180)} */\n  ${alias}(input: ${input}): Promise<ToolResult>`]
  })
  return [
    "```ts",
    "type ToolResult = { title: string; output: string; metadata: Record<string, unknown>; structured?: unknown }",
    "declare const tools: {",
    ...lines,
    ...aliasLines,
    "  /** Request-authorized MCP tools are callable by their exact ALL_TOOLS catalog name. */",
    "  [mcpToolName: string]: (input: Record<string, unknown>) => Promise<ToolResult>",
    "}",
    "/** Every tool callable in this execution. Search names and descriptions to discover tools without mcp_tool_search. */",
    "declare const ALL_TOOLS: ReadonlyArray<{ name: string; description: string }>",
    "// Raw file IO for machine-to-machine data (pipelines across executions).",
    "declare const files: {",
    "  /** Raw file contents — no line numbers, no truncation. null if missing. Paths: worktree or OS tmp. */",
    "  readText(path: string): Promise<string | null>",
    "  /** Write raw text; parent dirs auto-created. OS tmp dir ONLY — project writes go through tools.apply_patch. */",
    "  writeText(path: string, content: string): Promise<void>",
    "}",
    "```",
  ].join("\n")
}

/** Guest-side prelude: `tools` proxy → __callTool RPC, console → __log capture.
 * Prepended AFTER transpilation so it stays plain JS. The catch-rethrow exists
 * because the sandbox promise bridge rejects with a plain STRING (not Error) —
 * wrapping restores `e.message` / `e instanceof Error` for guest catch blocks. */
const GUEST_PRELUDE = `
const tools = new Proxy({}, {
  get: (_t, name) => (args) =>
    __callTool(String(name), args === undefined ? {} : args).catch((e) => {
      throw e instanceof Error ? e : new Error(String(e));
    }),
});
// Explicit JSON-safe serializer. JSON.stringify (and the sandbox marshal
// fallback) silently degrades non-JSON values — circular refs became
// "[object Object]", NaN became null with no signal, Error lost its message.
// strict mode (return values): unserializable → throw with a $.path; lossy
// conversions → recorded warnings. lenient mode (console.log): never throws,
// inlines markers like [Circular] instead.
function __serialize(root, lenient) {
  const warnings = [];
  const seen = new Set();
  const segs = [];
  const at = () => "$" + segs.join("");
  const warn = (m) => { if (warnings.length < 20) warnings.push(m); };
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const walk = (v) => {
    if (v === null) return null;
    const t = typeof v;
    if (t === "string" || t === "boolean") return v;
    if (t === "number") {
      if (Number.isFinite(v)) return v;
      const label = Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
      if (lenient) return label;
      warn(label + " at " + at() + " serialized as null");
      return null;
    }
    if (t === "bigint") {
      if (lenient) return String(v) + "n";
      throw new Error("return value is not JSON-serializable: BigInt at " + at() + " — convert with Number() or String() before returning");
    }
    if (t === "undefined") return undefined;
    if (t === "function") {
      if (lenient) return "[function]";
      warn("function at " + at() + " dropped (not JSON-serializable)");
      return undefined;
    }
    if (t === "symbol") {
      if (lenient) return String(v);
      warn("symbol at " + at() + " dropped (not JSON-serializable)");
      return undefined;
    }
    if (v instanceof Error) {
      if (!lenient) warn("Error at " + at() + " serialized as {name, message, stack}");
      return { name: v.name, message: v.message, stack: v.stack };
    }
    if (v instanceof Promise) {
      if (lenient) return "[Promise]";
      warn("unawaited Promise at " + at() + " serialized as null — did you forget an await?");
      return null;
    }
    if (seen.has(v)) {
      if (lenient) return "[Circular]";
      throw new Error("return value is not JSON-serializable: circular reference at " + at());
    }
    if (v instanceof RegExp) {
      if (!lenient) warn("RegExp at " + at() + " serialized as its string form");
      return String(v);
    }
    let obj = v;
    if (v instanceof Map) {
      if (!lenient) warn("Map at " + at() + " serialized as an entries array");
      obj = Array.from(v.entries());
    } else if (v instanceof Set) {
      if (!lenient) warn("Set at " + at() + " serialized as a values array");
      obj = Array.from(v.values());
    } else if (typeof v.toJSON === "function") {
      let j;
      try { j = v.toJSON(); } catch (e) {
        if (lenient) return "[toJSON threw: " + errMsg(e) + "]";
        throw new Error("toJSON at " + at() + " threw: " + errMsg(e));
      }
      if (j !== v) return walk(j);
    }
    seen.add(v);
    try {
      if (Array.isArray(obj)) {
        const out = [];
        for (let i = 0; i < obj.length; i++) {
          segs.push("[" + i + "]");
          const w = walk(obj[i]);
          out.push(w === undefined ? null : w);
          segs.pop();
        }
        return out;
      }
      const out = {};
      for (const key of Object.keys(obj)) {
        segs.push("." + key);
        let pv;
        try { pv = obj[key]; } catch (e) {
          if (lenient) { out[key] = "[getter threw: " + errMsg(e) + "]"; segs.pop(); continue; }
          throw new Error("return value is not JSON-serializable: getter at " + at() + " threw: " + errMsg(e));
        }
        const w = walk(pv);
        if (w !== undefined) out[key] = w;
        segs.pop();
      }
      return out;
    } finally { seen.delete(v); }
  };
  return { value: walk(root), warnings };
}
const __fmt = (x) => {
  if (typeof x === "string") return x;
  if (x instanceof Error) {
    const head = x.name + ": " + x.message;
    return x.stack ? head + "\\n" + x.stack : head;
  }
  try {
    const v = __serialize(x, true).value;
    return v === undefined ? "undefined" : JSON.stringify(v);
  } catch { return String(x); }
};
const console = {
  log: (...a) => __log(a.map(__fmt).join(" ")),
  error: (...a) => __log("[error] " + a.map(__fmt).join(" ")),
  warn: (...a) => __log("[warn] " + a.map(__fmt).join(" ")),
};
const __wrapErr = (e) => {
  throw e instanceof Error ? e : new Error(String(e));
};
// marshalIn maps host null to guest undefined; normalize back so the declared
// "string | null" contract holds for === null checks.
const files = {
  readText: (p) => __readText(p).then((v) => (v === undefined ? null : v), __wrapErr),
  writeText: (p, c) => __writeText(p, c).catch(__wrapErr),
};
`

/** Jail for the `files` raw-IO primitives. Read: worktree + OS tmp. Write: OS
 * tmp ONLY — project writes must go through tools.apply_patch so Permission.ask
 * applies (enforced here, not just advised in the prompt). Containment is
 * checked on REALPATHS: macOS /tmp and /var are symlinks into /private, so a
 * lexical check rejects the literal "/tmp/x" even though it lives inside the
 * canonical os.tmpdir() jail. For not-yet-existing targets (writes) the
 * deepest existing ancestor is canonicalized and the remainder re-appended. */
function realpathBestEffort(p: string): string {
  let cur = p
  let suffix = ""
  while (true) {
    try {
      return path.join(fs.realpathSync.native(cur), suffix)
    } catch {
      suffix = suffix ? path.join(path.basename(cur), suffix) : path.basename(cur)
      const parent = path.dirname(cur)
      if (parent === cur) return p
      cur = parent
    }
  }
}

function resolveJailed(roots: string[], p: string, kind: "read" | "write"): string {
  const canonRoots = roots.map(realpathBestEffort)
  const abs = realpathBestEffort(path.resolve(canonRoots[0], p))
  if (canonRoots.some((root) => abs === root || Filesystem.contains(root, abs))) return abs
  throw new Error(
    kind === "write"
      ? `files.writeText is limited to the OS temp dir — write project files via tools.apply_patch: ${JSON.stringify(p)}`
      : `path outside allowed roots (worktree, tmp): ${JSON.stringify(p)}`,
  )
}

type TraceEntry = {
  name: string
  status: "success" | "error"
  durationMs: number
  error?: string
}

export type ExecSubPartSnapshot = {
  seq: number
  type: "tool"
  callID: string
  tool: string
  state: {
    status: "running" | "completed" | "error"
    input: unknown
    title?: string
    output?: string
    error?: string
    metadata?: Record<string, unknown>
    providerOutput?: unknown
    providerMetadata?: Record<string, unknown>
    time: { start: number; end?: number }
    attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
  }
}

export const EXEC_METADATA_SCHEMA = 1

function metadataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function optionalMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

const ExecAttachment = MessageV2.FilePart.omit({ id: true, sessionID: true, messageID: true })
type ExecAttachment = z.infer<typeof ExecAttachment>

function normalizeAttachments(value: unknown): ExecAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const attachments = value.flatMap((item) => {
    const parsed = ExecAttachment.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
  return attachments.length ? attachments : undefined
}

export function viewExecSubtools(metadata: unknown): ExecSubPartSnapshot[] {
  const root = metadataRecord(metadata)
  if (root.exec_schema !== EXEC_METADATA_SCHEMA || !Array.isArray(root.sub_parts)) return []
  const seenSeq = new Set<number>()
  const seenCallID = new Set<string>()
  return root.sub_parts
    .flatMap((value) => {
      const item = metadataRecord(value)
      const seq = item.seq
      const callID = item.callID
      const tool = item.tool
      const type = item.type
      const state = metadataRecord(item.state)
      const status = state.status
      const input = state.input
      const time = metadataRecord(state.time)
      const start = time.start
      const end = time.end
      const stateMetadata = optionalMetadata(state.metadata)
      const attachments = normalizeAttachments(state.attachments)
      if (
        typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 ||
        type !== "tool" ||
        typeof callID !== "string" || callID.length === 0 ||
        seenSeq.has(seq) || seenCallID.has(callID) ||
        typeof tool !== "string" || tool.length === 0 ||
        (status !== "running" && status !== "completed" && status !== "error") ||
        !Object.prototype.hasOwnProperty.call(state, "input") ||
        typeof start !== "number" || !Number.isFinite(start) ||
        ((status === "completed" || status === "error") && (typeof end !== "number" || !Number.isFinite(end))) ||
        (status === "completed" && (typeof state.title !== "string" || typeof state.output !== "string")) ||
        (status === "error" && typeof state.error !== "string")
      ) return []
      seenSeq.add(seq)
      seenCallID.add(callID)
      return [{
        seq,
        type: "tool" as const,
        callID,
        tool,
        state: {
          status,
          input,
          ...(typeof state.title === "string" ? { title: state.title } : {}),
          ...(typeof state.output === "string" ? { output: state.output } : {}),
          ...(typeof state.error === "string" ? { error: state.error } : {}),
          ...(stateMetadata ? { metadata: stateMetadata } : {}),
          time: {
            start,
            ...(typeof end === "number" && Number.isFinite(end) ? { end } : {}),
          },
          ...(attachments ? { attachments } : {}),
          ...(state.providerOutput !== undefined ? { providerOutput: state.providerOutput } : {}),
          ...(optionalMetadata(state.providerMetadata) ? { providerMetadata: optionalMetadata(state.providerMetadata) } : {}),
        },
      } satisfies ExecSubPartSnapshot]
    })
    .toSorted((a, b) => a.seq - b.seq)
}

function makeSemaphore(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

export const ToolScriptTool = Tool.define(
  "exec",
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    const agents = yield* Agent.Service
    return {
      description: DESCRIPTION,
      parameters: z.object({
        code: z
          .string()
          .describe(
            "The `code` field value is raw JavaScript or TypeScript source for the body of an async function, not JSON or a Markdown code block. The outer exec tool arguments must still be a JSON object containing this field. Call tools via the global `tools` object; inspect `ALL_TOOLS` when needed; `return` the final aggregated value.",
          ),
        max_tool_calls: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOOL_CALLS_CEILING)
          .optional()
          .describe(
            `Tool call budget for this execution (default ${MAX_TOOL_CALLS_DEFAULT}, max ${MAX_TOOL_CALLS_CEILING}). Raise it only when the work genuinely needs more calls.`,
          ),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(ACTIVE_DEADLINE_MS_CEILING)
          .optional()
          .describe(
            `Compute-time budget in milliseconds (default ${ACTIVE_DEADLINE_MS_DEFAULT}, max ${ACTIVE_DEADLINE_MS_CEILING}). Counts only active script compute — time parked on tool calls is not charged.`,
          ),
      }),
      execute: (params: { code: string; max_tool_calls?: number; timeout?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const code = normalizeExecCode(params.code)
          const maxToolCalls = params.max_tool_calls ?? MAX_TOOL_CALLS_DEFAULT
          const activeDeadlineMs = params.timeout ?? ACTIVE_DEADLINE_MS_DEFAULT
          const trace: TraceEntry[] = []
          const subParts: ExecSubPartSnapshot[] = []
          const subPartByCallID = new Map<string, ExecSubPartSnapshot>()
          const progress: {
            pending: Promise<void>
            timer?: ReturnType<typeof setTimeout>
            dirty: boolean
            closed: boolean
          } = { pending: Promise.resolve(), dirty: false, closed: false }
          const snapshotSubParts = () =>
            subParts.map((part) => ({
              ...part,
              state: {
                ...part.state,
                input:
                  part.state.input && typeof part.state.input === "object"
                    ? Array.isArray(part.state.input)
                      ? [...part.state.input]
                      : { ...part.state.input }
                    : part.state.input,
                ...(part.state.metadata ? { metadata: { ...part.state.metadata } } : {}),
                ...(part.state.attachments ? { attachments: [...part.state.attachments] } : {}),
              },
            }))
          const terminalMetadata = (status: string) => ({
            status,
            toolCalls: subParts.length,
            counts: tally(),
            recent: recentTail(),
            exec_schema: EXEC_METADATA_SCHEMA,
            sub_parts: snapshotSubParts(),
          })
          // completeToolCall REPLACES part metadata with execute()'s return value,
          // so every terminal return re-publishes the complete nested metadata —
          // otherwise live progress vanishes the instant the run finishes.
          const tally = () => {
            const counts: Record<string, { n: number; errors: number }> = {}
            for (const t of trace) {
              const c = (counts[t.name] ??= { n: 0, errors: 0 })
              c.n++
              if (t.status === "error") c.errors++
            }
            return counts
          }
          // Bounded per-call trace tail for the TUI (last N calls, error text
          // truncated) — kept small so metadata deltas stay cheap on 500-call
          // runs. Re-published on terminal returns for the same reason as
          // tally(): completeToolCall replaces part metadata.
          const recentTail = () =>
            trace.slice(-TRACE_TAIL_ENTRIES).map((t) => ({
              name: t.name,
              status: t.status,
              durationMs: t.durationMs,
              ...(t.error && { error: t.error.slice(0, 200) }),
            }))
          if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
            return {
              title: "code too large",
              metadata: terminalMetadata("code_error"),
              output: `<exec status="code_error">\n<error_message>\ncode exceeds ${MAX_CODE_BYTES} bytes\n</error_message>\n</exec>`,
            }
          }

          const getDefs = toolScriptRegistry.current
          if (!getDefs) throw new Error("exec tool registry unavailable")
          const agentInfo = yield* agents.get(ctx.agent)
          const model = ctx.extra?.model as
            | { id: ModelID; providerID: ProviderID; api?: { id: string }; family?: string }
            | undefined
          const harness = ctx.extra?.harness as HarnessMode | undefined
          const whitelist = Array.isArray(ctx.extra?.toolWhitelist)
            ? new Set(ctx.extra.toolWhitelist.filter((id): id is string => typeof id === "string"))
            : undefined
          const defs = (
            yield* getDefs(
              model
                ? {
                    providerID: model.providerID,
                    modelID: model.id,
                    apiModelID: model.api?.id,
                    family: model.family,
                    agent: agentInfo,
                    harness,
                  }
                : undefined,
            )
          ).filter((def) => !TOOL_SCRIPT_EXCLUDED.has(def.id) && (!whitelist || whitelist.has(def.id)))
          const byId = new Map(defs.map((def) => [def.id, def]))
          // Request-authorized MCP tools (delivered via ctx.extra.execMcp and
          // filled by SessionPrompt's resolveTools for THIS request). Tool Search
          // only limits the outer model's schema list; exec receives the full
          // authorized view so it can call tools[exactCatalogName](...) directly.
          // A module-level ref would be overwritten by concurrent sessions.
          // Builtin ids win on collision — an MCP server must not shadow `read`.
          const mcpTools = (ctx.extra?.execMcp as { current?: Record<string, AiTool> } | undefined)?.current ?? {}
          const mcpById = new Map(
            Object.entries(mcpTools).filter(([id]) => !byId.has(id) && (!whitelist || whitelist.has(id))),
          )
          const allTools = [
            ...[...byId.values()]
              .filter((def) => !Object.values(TOOL_SCRIPT_ALIASES).some((target) => target === def.id))
              .map((def) => ({ name: def.id, description: def.description })),
            ...Object.entries(TOOL_SCRIPT_ALIASES).flatMap(([name, target]) => {
              const def = byId.get(target)
              if (!def) return []
              return [{
                name,
                description: name === "exec_command" ? EXEC_COMMAND_DESCRIPTION : `Alias for ${target}. ${def.description}`,
              }]
            }),
            ...[...mcpById.entries()].map(([name, tool]) => ({ name, description: tool.description ?? "" })),
          ]
          // Non-git projects report worktree === "/" (see Instance.containsPath) —
          // "/" as a jail root would allow EVERYTHING. Fall back to the project
          // directory in that case. Relative guest paths resolve against roots[0].
          // "/tmp" is allowed alongside os.tmpdir(): on macOS they are DIFFERENT
          // directories (/private/tmp vs /private/var/folders/...), and the tool
          // description's staging example uses "/tmp/..." — both must work.
          const ins = yield* InstanceState.context
          const tmpRoots = [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])]
          const jailRoots = [ins.worktree === "/" ? ins.directory : ins.worktree, ...tmpRoots]

          // Snapshot the Effect context BEFORE crossing into Promise-land: the
          // quickjs hook boundary loses Instance/Workspace context otherwise.
          const bridge = yield* EffectBridge.make()

          // Wrap before transpiling: the code is the BODY of an async function
          // (top-level `return`/`await`), which is invalid at module top level.
          // The wrapped form transpiles to a plain JS async-arrow expression the
          // guest body can invoke. Use TypeScript rather than Bun.Transpiler: this
          // core module also ships in the Node bundle, and some standalone Bun
          // runtimes expose Transpiler without a constructible implementation.
          // Report line/column relative to the CALLER's code (the wrapper adds one
          // line above), plus source text — a bare parse error is undebuggable.
          const source = `globalThis.__main = async () => {\n${code}\n}`
          const result = ts.transpileModule(source, {
            reportDiagnostics: true,
            compilerOptions: {
              module: ts.ModuleKind.ESNext,
              target: ts.ScriptTarget.ESNext,
            },
          })
          const hasImport = /^\s*(import|export)\s/m.test(code)
          const formatDiagnostics = (diagnostics: readonly ts.Diagnostic[]): string => {
            const rendered = diagnostics
              .map((diagnostic) => {
                if (!diagnostic.file || diagnostic.start === undefined)
                  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
                const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
                return `line ${pos.line}, column ${pos.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}\n  ${diagnostic.file.text.split("\n")[pos.line] ?? ""}`
              })
              .join("\n")
            const importHint = hasImport
              ? "\nnote: import/export are NOT supported — the code runs as a sandboxed function body. Use the provided `tools` / `files` globals instead of Node modules."
              : ""
            return `TypeScript transpile failed:\n${rendered || "import/export declaration is not supported"}${importHint}`
          }
          if (result.diagnostics?.length || hasImport) {
            return {
              title: "transpile error",
              metadata: terminalMetadata("code_error"),
              output: `<exec status="code_error">\n<error_message>\n${formatDiagnostics(result.diagnostics ?? [])}\n</error_message>\n</exec>`,
            }
          }
          const transpiled = result.outputText

          const logs: string[] = []
          let logBytes = 0
          let calls = 0
          const withSlot = makeSemaphore(MAX_CONCURRENT)

          // Live progress for the TUI: after each settled call, publish the
          // aggregated counts, complete nested metadata records, and a bounded
          // display tail through the OUTER part's metadata. Nested records are
          // complete because actor references can arrive before the call settles.
          // Fire-and-forget — progress must never fail a call.
          const enqueueProgress = () => {
            if (progress.closed || !progress.dirty) return
            progress.dirty = false
            const metadata = {
              running: true,
              toolCalls: subParts.length,
              counts: tally(),
              recent: recentTail(),
              exec_schema: EXEC_METADATA_SCHEMA,
              sub_parts: snapshotSubParts(),
            }
            progress.pending = progress.pending
              .then(() => bridge.promise(ctx.metadata({ metadata })))
              .catch(() => {})
          }
          const publishProgress = (options?: { immediate?: boolean }) => {
            if (progress.closed) return
            progress.dirty = true
            if (options?.immediate) {
              if (progress.timer) {
                clearTimeout(progress.timer)
                progress.timer = undefined
              }
              enqueueProgress()
              return
            }
            if (progress.timer) clearTimeout(progress.timer)
            progress.timer = setTimeout(() => {
              progress.timer = undefined
              enqueueProgress()
            }, EXEC_PROGRESS_DEBOUNCE_MS)
          }
          const flushProgress = () =>
            Effect.promise(async () => {
              if (progress.timer) {
                clearTimeout(progress.timer)
                progress.timer = undefined
              }
              closeProgress()
              enqueueProgress()
              progress.closed = true
              await progress.pending
            })
          const closeProgress = () => {
            if (progress.closed) return
            if (progress.timer) {
              clearTimeout(progress.timer)
              progress.timer = undefined
            }
            for (const part of subParts) {
              if (part.state.status !== "running") continue
              part.state = {
                status: "error",
                input: part.state.input,
                ...(typeof part.state.title === "string" ? { title: part.state.title } : {}),
                error: "exec terminated before nested tool completed",
                ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
                time: { ...part.state.time, end: Date.now() },
              }
            }
            progress.dirty = true
          }

          const callTool: HostFn = (name: unknown, args: unknown) => {
            const id = String(name)
            const alias = TOOL_SCRIPT_ALIASES[id as keyof typeof TOOL_SCRIPT_ALIASES]
            const def = byId.get(alias ?? id)
            const mcpID = def ? undefined : ToolCompat.resolveName(id, [...mcpById.keys()])
            const mcpDef = mcpID ? mcpById.get(mcpID) : undefined
            if (!def && !mcpDef) return Promise.reject(new Error(`unknown tool: ${id}`))
            const toolArgs = id === "exec_command" ? execCommandArgs(args) : args
            calls++
            if (calls > maxToolCalls)
              return Promise.reject(new Error(`tool call budget exceeded (${maxToolCalls} per execution)`))
            const seq = calls
            const start = Date.now()
            const callID = `${ctx.callID ?? "exec"}:${seq}`
            const subPart: ExecSubPartSnapshot = {
              seq,
              type: "tool",
              callID,
              tool: id,
              state: {
                status: "running",
                input: toolArgs,
                time: { start },
              },
            }
            subParts.push(subPart)
            subPartByCallID.set(callID, subPart)
            publishProgress({ immediate: subParts.length === 1 })
            const subCtx = {
              ...ctx,
              extra: { ...ctx.extra, fromExec: true },
              callID,
              // Capture nested metadata in its own record. Forwarding it to the
              // outer context would replace exec's title and lose sibling calls.
              metadata: (value: { title?: string; metadata?: Record<string, unknown> }) =>
                Effect.sync(() => {
                  const current = subPartByCallID.get(callID)
                  if (!current) return
                  if (current.state.status !== "running") return
                  current.state = {
                    ...current.state,
                    status: "running",
                    ...(value.title ? { title: value.title } : {}),
                    ...(value.metadata ? { metadata: metadataRecord(value.metadata) } : {}),
                  }
                  publishProgress()
                }),
            }
            // MCP path: the map holds SessionPrompt's WRAPPED executes, so the
            // full direct-call pipeline applies unchanged — permission ask,
            // plugin before/after hooks, metrics, normalizeToolResult folding,
            // truncation. Here we only adapt the wrapped result shape for the
            // guest: structuredContent (when the server sent it) crosses as a
            // parsed value under `structured` so scripts can filter/aggregate
            // without re-parsing text; media attachments cannot cross the
            // sandbox string boundary and are dropped with a note.
            type ExecNestedResult = {
              title: string
              output: string
              metadata: Record<string, unknown>
              attachments?: ExecAttachment[]
              structured?: unknown
              providerOutput?: unknown
              providerMetadata?: Record<string, unknown>
            }
            const executeMcp = (tool: AiTool) =>
              Effect.tryPromise({
                try: () =>
                  Promise.resolve(
                    tool.execute!(toolArgs ?? {}, {
                      toolCallId: subCtx.callID,
                      messages: [],
                      abortSignal: ctx.abort,
                    }),
                  ),
                catch: (err) => (err instanceof Error ? err : new Error(String(err))),
              }).pipe(
                Effect.map((result): ExecNestedResult => {
                  const r = result as {
                    output?: unknown
                    metadata?: { mcp?: { structuredContent?: unknown } }
                    attachments?: unknown[]
                  }
                  const structured = r?.metadata?.mcp?.structuredContent
                  const dropped = Array.isArray(r?.attachments) && r.attachments.length
                    ? `\n[note: ${r.attachments.length} non-text attachment(s) dropped — binary content cannot cross the exec sandbox]`
                    : ""
                  return {
                    title: id,
                    output: String(r?.output ?? "") + dropped,
                    metadata: (r?.metadata ?? {}) as Record<string, unknown>,
                    attachments: normalizeAttachments(r?.attachments),
                    ...(structured !== undefined && { structured }),
                  }
                }),
              )
            const executeBuiltin = def
              ? def.execute(toolArgs, subCtx).pipe(
                  Effect.map((result): ExecNestedResult => ({
                    title: result.title,
                    output: result.output,
                    metadata: result.metadata,
                    attachments: normalizeAttachments(result.attachments),
                    providerOutput: (result as { providerOutput?: unknown }).providerOutput,
                    providerMetadata: (result as { providerMetadata?: Record<string, unknown> }).providerMetadata,
                  })),
                )
              : executeMcp(mcpDef!)
            return withSlot(() =>
              bridge
                .promise(executeBuiltin)
                .then(
                  (result) => {
                    if (progress.closed || subPart.state.status !== "running")
                      return {
                        title: result.title,
                        output: result.output,
                        metadata: result.metadata,
                      }
                    const durationMs = Date.now() - start
                    subPart.state = {
                      status: "completed",
                      input: subPart.state.input,
                      title: result.title,
                      output: result.output,
                      metadata: metadataRecord(result.metadata),
                      ...(result.providerOutput !== undefined ? { providerOutput: result.providerOutput } : {}),
                      ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}),
                      time: { start, end: Date.now() },
                      ...(result.attachments ? { attachments: result.attachments } : {}),
                    }
                    trace.push({ name: id, status: "success", durationMs })
                    publishProgress()
                    const structured = (result as { structured?: unknown }).structured
                    return {
                      title: result.title,
                      output: result.output,
                      metadata: result.metadata,
                      ...(structured !== undefined && { structured }),
                    }
                  },
                  (err) => {
                    const message = err instanceof Error ? err.message : String(err)
                    if (progress.closed || subPart.state.status !== "running") throw new Error(`${id}: ${message}`)
                    const durationMs = Date.now() - start
                    const toolResultMetadata = getToolResultMetadata(err)
                    const toolResultAttachments = normalizeAttachments(getToolResultAttachments(err))
                    const currentMetadata = subPart.state.metadata
                    subPart.state = {
                      status: "error",
                      input: subPart.state.input,
                      ...(typeof subPart.state.title === "string" ? { title: subPart.state.title } : {}),
                      error: message,
                      ...((currentMetadata || toolResultMetadata)
                        ? { metadata: { ...currentMetadata, ...toolResultMetadata, ...(isRecoverableError(err) ? { recoverable: true } : {}) } }
                        : isRecoverableError(err) ? { metadata: { recoverable: true } }
                        : {}),
                      time: { start, end: Date.now() },
                      ...(toolResultAttachments?.length ? { attachments: toolResultAttachments } : {}),
                    }
                    trace.push({ name: id, status: "error", durationMs, error: message })
                    publishProgress()
                    throw new Error(`${id}: ${message}`)
                  },
                ),
            )
          }

          const logHook: HostFn = (message: unknown) => {
            const text = String(message)
            if (logBytes >= MAX_LOG_BYTES) return undefined
            logBytes += Buffer.byteLength(text, "utf8")
            logs.push(logBytes >= MAX_LOG_BYTES ? text.slice(0, 200) + " …(log budget exhausted)" : text)
            return undefined
          }

          // Raw file IO (`files.*`): machine-to-machine data channel, bypassing the
          // agent-facing read/write formatting (line numbers, truncation). Reads are
          // jailed to worktree + OS tmp; writes to OS tmp ONLY (project writes must
          // carry permissions → tools.apply_patch). Read side also caps size so a
          // giant file can't blow the guest memory limit.
          const readText: HostFn = async (p: unknown) => {
            const abs = resolveJailed(jailRoots, String(p), "read")
            const file = Bun.file(abs)
            if (!(await file.exists())) return null
            if (file.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes: ${String(p)}`)
            // Non-UTF-8 content cannot survive the string boundary into the guest
            // (Bun's .text() folds invalid sequences to U+FFFD and NULs previously
            // truncated at the C-string marshal). Fail loud instead of silently
            // returning corrupted/empty data.
            const bytes = await file.bytes()
            try {
              return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
            } catch {
              throw new Error(
                `file is not valid UTF-8 text (binary content cannot cross the sandbox string boundary): ${String(p)}`,
              )
            }
          }
          const writeText: HostFn = async (p: unknown, content: unknown) => {
            const abs = resolveJailed(tmpRoots, String(p), "write")
            const text = String(content)
            if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES)
              throw new Error(`content exceeds ${MAX_FILE_BYTES} bytes`)
            await Filesystem.write(abs, text)
            return undefined
          }

          const outcome = yield* Effect.tryPromise({
            try: () =>
              // The return value is serialized IN THE GUEST via __serialize (strict):
              // unserializable values (circular refs, BigInt, throwing getters) throw
              // with a $.path instead of silently degrading to "[object Object]",
              // and lossy conversions (NaN→null, Map→array, Error→plain object) are
              // reported as warnings. The envelope crosses the boundary as plain JSON.
              evalScript(
                `const ALL_TOOLS = Object.freeze(${JSON.stringify(allTools)}.map(Object.freeze));\n` +
                  GUEST_PRELUDE +
                  "\n" +
                  transpiled +
                  `\nconst __ret = await globalThis.__main();
const __out = __serialize(__ret, false);
return { __undef: __out.value === undefined, json: __out.value === undefined ? "" : JSON.stringify(__out.value), warnings: __out.warnings };`,
                {
                __callTool: callTool,
                __log: logHook,
                __readText: readText,
                __writeText: writeText,
              }, {
                deterministic: false,
                deadlineMs: WALL_DEADLINE_MS,
                activeDeadlineMs,
                interrupt: () => ctx.abort.aborted,
              }),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(Effect.result)

          const traceLines = trace.map(
            (t) => `- ${t.name} → ${t.status}${t.error ? ` (${t.error.slice(0, 200)})` : ""} [${t.durationMs}ms]`,
          )
          const logBlock = logs.length ? `<logs>\n${logs.join("\n")}\n</logs>\n` : ""
          const traceBlock = trace.length ? `<trace count="${trace.length}">\n${traceLines.join("\n")}\n</trace>\n` : ""

          if (outcome._tag === "Failure") {
            const message = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
            const status = ctx.abort.aborted
              ? "cancelled"
              : message.includes("deadline exceeded") || message.includes("interrupted")
                ? "timeout"
                : message.includes("budget exceeded")
                  ? "budget_exceeded"
                  : "code_error"
            // The raw interrupt error ({"name":"InternalError","message":"interrupted"})
            // reads like an engine fault — explain which budget was exhausted.
            const explained =
              status === "timeout"
                ? `execution exceeded its time budget (${activeDeadlineMs}ms of active compute, ${WALL_DEADLINE_MS / 60000}min wall clock — time parked on tool calls is not charged against the compute budget; raise via timeout, max ${ACTIVE_DEADLINE_MS_CEILING}ms). Original error: ${message}`
                : message
            log.warn("exec failed", { status, message: explained.slice(0, 500) })
            yield* flushProgress()
            return {
              title: status,
              metadata: terminalMetadata(status),
              output: `<exec status="${status}">\n<error_message>\n${explained}\n</error_message>\n${logBlock}${traceBlock}</exec>`,
            }
          }

          // XML-wrap the return value verbatim: no JSON.stringify → no \n / \" escaping
          // pollution. Strings pass through as-is; non-strings arrive as guest-side
          // strict-serialized JSON (see __serialize) and are re-indented for readability.
          const envelope = outcome.success as { __undef: boolean; json: string; warnings: string[] }
          const parsed = envelope.__undef ? undefined : (JSON.parse(envelope.json) as unknown)
          const returnedText =
            parsed === undefined ? "undefined" : typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)
          const warningsBlock = envelope.warnings.length
            ? `<warnings>\n${envelope.warnings.map((w) => `- ${w}`).join("\n")}\n</warnings>\n`
            : ""
          const returnedBytes = Buffer.byteLength(returnedText, "utf8")
          if (returnedBytes > MAX_RESULT_BYTES) {
            yield* flushProgress()
            return {
              title: "result too large",
              metadata: terminalMetadata("budget_exceeded"),
              output: `<exec status="budget_exceeded">\n<error_message>\nreturned value is ${returnedBytes} bytes (max ${MAX_RESULT_BYTES}). Aggregate or slice the data before returning.\n</error_message>\n${warningsBlock}${logBlock}${traceBlock}</exec>`,
            }
          }

          yield* flushProgress()
          return {
            title: `${subParts.length} tool calls`,
            metadata: terminalMetadata("completed"),
            output: `<exec status="completed">\n<return_value>\n${returnedText}\n</return_value>\n${warningsBlock}${logBlock}${traceBlock}</exec>`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
