import z from "zod"
import os from "os"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { asSchema, type Tool as AiTool } from "ai"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { EffectBridge, InstanceState } from "@/effect"
import { Log, Filesystem } from "@/util"
import { Agent } from "@/agent/agent"
import { normalizeToolResult } from "../mcp/tool-result"
import { evalScript, type HostFn } from "../workflow/sandbox"
import { toolScriptRegistry, toolScriptMcp, TOOL_SCRIPT_EXCLUDED } from "./tool-script-ref"
import DESCRIPTION from "./tool-script.txt"
import * as Tool from "./tool"
import * as Truncate from "./truncate"

const log = Log.create({ service: "tool.tool_script" })

const MAX_TOOL_CALLS_DEFAULT = 50
const MAX_TOOL_CALLS_CEILING = 500
const MAX_CONCURRENT = 8
const ACTIVE_DEADLINE_S_DEFAULT = 60
const ACTIVE_DEADLINE_S_CEILING = 600
const WALL_DEADLINE_MS = 30 * 60 * 1000
const MAX_RESULT_BYTES = 256 * 1024
const MAX_LOG_BYTES = 64 * 1024
const MAX_CODE_BYTES = 128 * 1024
const MAX_FILE_BYTES = 10 * 1024 * 1024

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
export function renderToolScriptDeclarations(defs: Tool.Def[], mcp: Record<string, AiTool> = {}): string {
  const lines = defs
    .filter((def) => !TOOL_SCRIPT_EXCLUDED.has(def.id))
    .map((def) => {
      const summary = def.description.split("\n").find((l) => l.trim()) ?? ""
      const input = schemaToTs(z.toJSONSchema(def.parameters))
      return `  /** ${summary.trim().slice(0, 200)} */\n  ${def.id}(input: ${input}): Promise<ToolResult>`
    })
  const mcpLines = Object.entries(mcp).map(([id, tool]) => {
    const summary = (tool.description ?? "").split("\n").find((l) => l.trim()) ?? ""
    const input = schemaToTs(asSchema(tool.inputSchema).jsonSchema)
    return `  /** [MCP] ${summary.trim().slice(0, 200)} */\n  ${id}(input: ${input}): Promise<ToolResult>`
  })
  return [
    "```ts",
    "type ToolResult = { title: string; output: string; metadata: Record<string, unknown> }",
    "declare const tools: {",
    ...lines,
    ...mcpLines,
    "}",
    "// Raw file IO for machine-to-machine data (pipelines across executions).",
    "declare const files: {",
    "  /** Raw file contents — no line numbers, no truncation. null if missing. Paths: worktree or OS tmp. */",
    "  readText(path: string): Promise<string | null>",
    "  /** Write raw text; parent dirs auto-created. OS tmp dir ONLY — project writes go through tools.write/edit. */",
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
 * tmp ONLY — project writes must go through tools.write/edit so Permission.ask
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
      ? `files.writeText is limited to the OS temp dir — write project files via tools.write/tools.edit: ${JSON.stringify(p)}`
      : `path outside allowed roots (worktree, tmp): ${JSON.stringify(p)}`,
  )
}

type TraceEntry = {
  name: string
  status: "success" | "error"
  durationMs: number
  error?: string
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
  "tool_script",
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    const agents = yield* Agent.Service
    return {
      description: DESCRIPTION,
      parameters: z.object({
        code: z
          .string()
          .describe(
            "TypeScript (or JavaScript) source for the body of an async function. Call tools via the global `tools` object; `return` the final aggregated value.",
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
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(ACTIVE_DEADLINE_S_CEILING)
          .optional()
          .describe(
            `Compute-time budget in seconds (default ${ACTIVE_DEADLINE_S_DEFAULT}, max ${ACTIVE_DEADLINE_S_CEILING}). Counts only active script compute — time parked on tool calls is not charged.`,
          ),
      }),
      execute: (params: { code: string; max_tool_calls?: number; timeout_seconds?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const maxToolCalls = params.max_tool_calls ?? MAX_TOOL_CALLS_DEFAULT
          const activeDeadlineMs = (params.timeout_seconds ?? ACTIVE_DEADLINE_S_DEFAULT) * 1000
          if (Buffer.byteLength(params.code, "utf8") > MAX_CODE_BYTES) {
            return {
              title: "code too large",
              metadata: { status: "code_error", toolCalls: 0 },
              output: `<tool_script status="code_error">\n<error_message>\ncode exceeds ${MAX_CODE_BYTES} bytes\n</error_message>\n</tool_script>`,
            }
          }

          const getDefs = toolScriptRegistry.current
          if (!getDefs) throw new Error("tool_script registry unavailable")
          const defs = (yield* getDefs()).filter((def) => !TOOL_SCRIPT_EXCLUDED.has(def.id))
          const byId = new Map(defs.map((def) => [def.id, def]))
          // MCP tools (late-bound ref, populated by SessionPrompt). Builtin ids
          // win on collision — an MCP server must not shadow `read`/`grep`.
          const mcpTools = toolScriptMcp.current ? yield* toolScriptMcp.current() : {}
          const mcpById = new Map(Object.entries(mcpTools).filter(([id]) => !byId.has(id)))
          const agentInfo = yield* agents.get(ctx.agent)
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
          // (top-level `return`/`await`), which is invalid at module top level —
          // Bun.Transpiler would reject it. The wrapped form transpiles to a plain
          // JS async-arrow expression the guest body can invoke.
          // Bun surfaces syntax errors as BuildMessage (single) or AggregateError
          // (several), each carrying a position. Report line/column relative to
          // the CALLER's code (the wrapper adds one line above), plus the source
          // line text — a bare "Parse error" is undebuggable in a 100-line script.
          const formatBuildError = (err: unknown): string => {
            const messages = err instanceof AggregateError ? err.errors : [err]
            const rendered = messages
              .map((m: any) => {
                const pos = m?.position
                if (!pos || typeof pos.line !== "number") return String(m?.message ?? m)
                return `line ${pos.line - 1}, column ${pos.column}: ${m.message}\n  ${pos.lineText ?? ""}`
              })
              .join("\n")
            const importHint = /^\s*(import|export)\s/m.test(params.code)
              ? "\nnote: import/export are NOT supported — the code runs as a sandboxed function body. Use the provided `tools` / `files` globals instead of Node modules."
              : ""
            return `TypeScript transpile failed:\n${rendered}${importHint}`
          }
          const transpiled = yield* Effect.try({
            try: () => new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__main = async () => {\n${params.code}\n}`),
            catch: (err) => err,
          }).pipe(Effect.catch((err) => Effect.succeed({ error: formatBuildError(err) })))
          if (typeof transpiled === "object") {
            return {
              title: "transpile error",
              metadata: { status: "code_error", toolCalls: 0 },
              output: `<tool_script status="code_error">\n<error_message>\n${transpiled.error}\n</error_message>\n</tool_script>`,
            }
          }

          const trace: TraceEntry[] = []
          const logs: string[] = []
          let logBytes = 0
          let calls = 0
          const withSlot = makeSemaphore(MAX_CONCURRENT)

          // Live progress for the TUI: after each settled call, publish the
          // aggregated per-tool counts through the OUTER part's metadata (each
          // ctx.metadata fires a part delta the ToolScript view renders
          // reactively). Fire-and-forget — progress must never fail a call.
          const publishProgress = () => {
            const counts: Record<string, { n: number; errors: number }> = {}
            for (const t of trace) {
              const c = (counts[t.name] ??= { n: 0, errors: 0 })
              c.n++
              if (t.status === "error") c.errors++
            }
            bridge.promise(ctx.metadata({ metadata: { running: true, toolCalls: trace.length, counts } })).catch(() => {})
          }

          const callTool: HostFn = (name: unknown, args: unknown) => {
            const id = String(name)
            const def = byId.get(id)
            const mcpDef = def ? undefined : mcpById.get(id)
            if (!def && !mcpDef) return Promise.reject(new Error(`unknown tool: ${id}`))
            calls++
            if (calls > maxToolCalls)
              return Promise.reject(new Error(`tool call budget exceeded (${maxToolCalls} per execution)`))
            const seq = calls
            const start = Date.now()
            const subCtx = {
              ...ctx,
              callID: `${ctx.callID ?? "tool_script"}:${seq}`,
              // Sub-call metadata would clobber the outer tool_script call's
              // title in the UI — swallow it; the trace covers observability.
              metadata: () => Effect.void,
            }
            // MCP path: same permission gate as the direct SessionPrompt MCP
            // wrapper (ask per tool name), then normalizeToolResult folds the
            // content blocks to text. Non-text blocks (images, audio, blobs)
            // cannot cross the sandbox string boundary — note them so the
            // script (and the model reading the aggregate) knows data was
            // dropped rather than absent.
            const executeMcp = (tool: AiTool) =>
              Effect.gen(function* () {
                yield* ctx.ask({ permission: id, metadata: {}, patterns: ["*"], always: ["*"] })
                const result = (yield* Effect.promise(() =>
                  Promise.resolve(
                    tool.execute!(args ?? {}, {
                      toolCallId: subCtx.callID,
                      messages: [],
                      abortSignal: ctx.abort,
                    }),
                  ),
                )) as CallToolResult
                const normalized = normalizeToolResult(result)
                if (normalized.isError) return yield* Effect.fail(new Error(normalized.output || "MCP tool execution failed"))
                const dropped = normalized.attachments.length
                  ? `\n[note: ${normalized.attachments.length} non-text attachment(s) dropped — binary content cannot cross the tool_script sandbox]`
                  : ""
                const truncated = yield* truncate.output(normalized.output + dropped, {}, agentInfo)
                return {
                  title: id,
                  output: truncated.content,
                  metadata: {
                    ...normalized.metadata,
                    truncated: truncated.truncated,
                    ...(truncated.truncated && { outputPath: truncated.outputPath }),
                  },
                } satisfies Tool.ExecuteResult
              })
            return withSlot(() =>
              bridge
                .promise(def ? def.execute(args, subCtx) : executeMcp(mcpDef!))
                .then(
                  (result) => {
                    trace.push({ name: id, status: "success", durationMs: Date.now() - start })
                    publishProgress()
                    return { title: result.title, output: result.output, metadata: result.metadata }
                  },
                  (err) => {
                    const message = err instanceof Error ? err.message : String(err)
                    trace.push({ name: id, status: "error", durationMs: Date.now() - start, error: message })
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
          // carry permissions → tools.write/edit). Read side also caps size so a
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
                ? `execution exceeded its time budget (${activeDeadlineMs / 1000}s of active compute, ${WALL_DEADLINE_MS / 60000}min wall clock — time parked on tool calls is not charged against the compute budget; raise via timeout_seconds, max ${ACTIVE_DEADLINE_S_CEILING}). Original error: ${message}`
                : message
            log.warn("tool_script failed", { status, message: explained.slice(0, 500) })
            return {
              title: status,
              metadata: { status, toolCalls: trace.length },
              output: `<tool_script status="${status}">\n<error_message>\n${explained}\n</error_message>\n${logBlock}${traceBlock}</tool_script>`,
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
            return {
              title: "result too large",
              metadata: { status: "budget_exceeded", toolCalls: trace.length },
              output: `<tool_script status="budget_exceeded">\n<error_message>\nreturned value is ${returnedBytes} bytes (max ${MAX_RESULT_BYTES}). Aggregate or slice the data before returning.\n</error_message>\n${warningsBlock}${logBlock}${traceBlock}</tool_script>`,
            }
          }

          return {
            title: `${trace.length} tool calls`,
            metadata: { status: "completed", toolCalls: trace.length },
            output: `<tool_script status="completed">\n<return_value>\n${returnedText}\n</return_value>\n${warningsBlock}${logBlock}${traceBlock}</tool_script>`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
