import z from "zod"
import os from "os"
import fs from "fs"
import path from "path"
import ts from "typescript"
import { Effect } from "effect"
import { asSchema, type Tool as AiTool } from "ai"
import { EffectBridge, InstanceState } from "@/effect"
import { Log, Filesystem } from "@/util"
import { Agent } from "@/agent/agent"
import type { ModelID, ProviderID } from "../provider/schema"
import { evalScript, type HostFn } from "../workflow/sandbox"
import { toolScriptRegistry, TOOL_SCRIPT_ALIASES, NOT_CALLABLE_IN_EXEC } from "./tool-script-ref"
import DESCRIPTION from "./tool-script.txt"
import * as Tool from "./tool"
import { createCodeModeOutputBuffer, startCell } from "./code-mode-cell"

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
const TRACE_TAIL_ENTRIES = 20
const SESSION_STORE_RETENTION_MS = 30 * 60 * 1000

type SessionStore = {
  values: Map<string, unknown>
  cleanup: ReturnType<typeof setTimeout>
}

const sessionStores = new Map<string, SessionStore>()

function sessionStore(sessionID: string) {
  const existing = sessionStores.get(sessionID)
  if (existing) clearTimeout(existing.cleanup)
  const store: SessionStore = {
    values: existing?.values ?? new Map<string, unknown>(),
    cleanup: setTimeout(() => sessionStores.delete(sessionID), SESSION_STORE_RETENTION_MS),
  }
  store.cleanup.unref?.()
  sessionStores.set(sessionID, store)
  return store.values
}

const Parameters = z.object({
  code: z.string(),
  yield_time_ms: z.number().int().nonnegative().safe().optional(),
  max_output_tokens: z.number().int().nonnegative().safe().optional(),
  max_tool_calls: z.number().int().min(1).max(MAX_TOOL_CALLS_CEILING).optional(),
  timeout: z.number().int().min(1).max(ACTIVE_DEADLINE_MS_CEILING).optional(),
})

/** JSON Schema (zod v4 toJSONSchema output) → compact TS type text. Best-effort:
 * anything unrecognized renders as `unknown`, which is safe for declarations. */
function schemaToTs(schema: any, depth = 0): string {
  if (!schema || typeof schema !== "object") return "unknown"
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ")
  const variants = schema.anyOf ?? schema.oneOf
  if (variants) return variants.map((variant: unknown) => schemaToTs(variant, depth)).join(" | ")
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
      return `Array<${schemaToTs(schema.items, depth)}>`
    case "object": {
      if (!schema.properties) {
        if (schema.additionalProperties && typeof schema.additionalProperties === "object")
          return `Record<string, ${schemaToTs(schema.additionalProperties, depth)}>`
        return "Record<string, unknown>"
      }
      if (Object.keys(schema.properties).length === 0) return "{}"
      const required = new Set<string>(schema.required ?? [])
      const indent = "  ".repeat(depth + 1)
      const fields = Object.entries(schema.properties).flatMap(([key, value]) => {
        const description =
          value && typeof value === "object" && "description" in value && typeof value.description === "string"
            ? value.description
            : undefined
        return [
          ...(description
            ? description.split("\n").map((line: string) => `${indent}// ${line}`)
            : []),
          `${indent}${key}${required.has(key) ? "" : "?"}: ${schemaToTs(value, depth + 1)};`,
        ]
      })
      return `{\n${fields.join("\n")}\n${"  ".repeat(depth)}}`
    }
    default:
      return "unknown"
  }
}

export const MCP_TYPESCRIPT_PREAMBLE = `type Role = "user" | "assistant";
type MetaObject = Record<string, unknown>;
type Annotations = {
  audience?: Role[];
  priority?: number;
  lastModified?: string;
};
type Icon = {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
};
type TextResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  text: string;
};
type BlobResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  blob: string;
};
type TextContent = {
  type: "text";
  text: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type AudioContent = {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ResourceLink = {
  icons?: Icon[];
  name: string;
  title?: string;
  uri: string;
  description?: string;
  mimeType?: string;
  annotations?: Annotations;
  size?: number;
  _meta?: MetaObject;
  type: "resource_link";
};
type EmbeddedResource = {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;
type CallToolResult<TStructured = { [key: string]: unknown }> = {
  _meta?: MetaObject;
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: TStructured;
  [key: string]: unknown;
};`

function mcpStructuredContentSchema(schema: any) {
  if (!schema || typeof schema !== "object" || !schema.properties) return undefined
  const content = schema.properties.content
  const isError = schema.properties.isError
  const meta = schema.properties._meta
  if (content?.type !== "array" || content.items?.type !== "object") return undefined
  if (isError?.type !== "boolean" || meta?.type !== "object") return undefined
  return schema.properties.structuredContent ?? true
}

export async function renderMcpToolScriptDeclarations(tools: Record<string, AiTool>) {
  const sections = (
    await Promise.all(
      Object.entries(tools).map(async ([rawName, tool]) => {
        if (!tool.outputSchema) return undefined
        const outputSchema = await Promise.resolve(asSchema(tool.outputSchema).jsonSchema)
        const structured = mcpStructuredContentSchema(outputSchema)
        if (!structured) return undefined
        const inputSchema = await Promise.resolve(asSchema(tool.inputSchema).jsonSchema)
        const name = normalizeCodeModeIdentifier(rawName)
        const heading = name === rawName ? `### \`${name}\`` : `### \`${name}\` (\`${rawName}\`)`
        const structuredType = structured === true ? "unknown" : schemaToTs(structured)
        const resultType = structuredType === "unknown" ? "CallToolResult" : `CallToolResult<${structuredType}>`
        return `${heading}\n${tool.description?.trim() ?? ""}\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { ${name}(args: ${schemaToTs(inputSchema)}): Promise<${resultType}>; };\n\`\`\``
      }),
    )
  ).filter((section): section is string => !!section)
  if (sections.length === 0) return ""
  return [`Shared MCP Types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``, ...sections].join("\n\n")
}

export const CODE_MODE_EXEC_GRAMMAR = `
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/
NEWLINE: /\\r?\\n/
SOURCE: /[\\s\\S]+/
`

const MAX_JS_SAFE_INTEGER = 2 ** 53 - 1

export function parseExecSource(input: string) {
  if (!input.trim()) {
    throw new Error(
      'exec expects raw JavaScript or TypeScript source text (non-empty). Provide source only, optionally with first-line `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.',
    )
  }

  const newline = input.indexOf("\n")
  const firstLine = newline === -1 ? input : input.slice(0, newline)
  const trimmed = firstLine.trimStart()
  if (!trimmed.startsWith("// @exec:")) {
    if (input.split(/\r?\n/).slice(1).some((line) => line.trimStart().startsWith("// @exec:"))) {
      throw new Error("exec pragma must be the first line of the tool input")
    }
    return { code: input, yield_time_ms: undefined, max_output_tokens: undefined }
  }
  const code = newline === -1 ? "" : input.slice(newline + 1)
  if (!code.trim()) throw new Error("exec pragma must be followed by JavaScript source on subsequent lines")
  const directive = trimmed.slice("// @exec:".length).trim()
  if (!directive) {
    throw new Error(
      "exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`",
    )
  }

  const value = (() => {
    try {
      return JSON.parse(directive) as unknown
    } catch (error) {
      throw new Error(
        `exec pragma must be valid JSON with supported fields \`yield_time_ms\` and \`max_output_tokens\`: ${error}`,
      )
    }
  })()
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`",
    )
  }
  const pragma = value as Record<string, unknown>
  const unsupported = Object.keys(pragma).find((key) => !["yield_time_ms", "max_output_tokens"].includes(key))
  if (unsupported) {
    throw new Error(
      `exec pragma only supports \`yield_time_ms\` and \`max_output_tokens\`; got \`${unsupported}\``,
    )
  }
  for (const key of ["yield_time_ms", "max_output_tokens"] as const) {
    const field = pragma[key]
    if (field === undefined) continue
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0 || field > MAX_JS_SAFE_INTEGER) {
      throw new Error(`exec pragma field \`${key}\` must be a non-negative safe integer`)
    }
  }
  return {
    code,
    yield_time_ms: pragma["yield_time_ms"] as number | undefined,
    max_output_tokens: pragma.max_output_tokens as number | undefined,
  }
}

function normalizeCodeModeIdentifier(name: string) {
  const normalized = [...name]
    .map((char, index) => (/[$_A-Za-z]/.test(char) || (index > 0 && /[0-9]/.test(char)) ? char : "_"))
    .join("")
  return normalized || "_"
}

/** Render the Codex code-mode declarations appended to the tool description. */
export function renderToolScriptDeclarations(defs: Tool.Def[]): string {
  const aliases = new Set(Object.keys(TOOL_SCRIPT_ALIASES))
  const sections = defs
    .filter((def) => !NOT_CALLABLE_IN_EXEC.has(def.id) && !aliases.has(def.id))
    .map((def) => {
      const input = def.id === "apply_patch" ? "string" : schemaToTs(z.toJSONSchema(def.parameters))
      const inputName = def.id === "apply_patch" ? "input" : "args"
      const name = normalizeCodeModeIdentifier(def.id)
      const heading = name === def.id ? `### \`${name}\`` : `### \`${name}\` (\`${def.id}\`)`
      return `${heading}\n${def.description.trim()}\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { ${name}(${inputName}: ${input}): Promise<unknown>; };\n\`\`\``
    })
  const aliasSections = Object.entries(TOOL_SCRIPT_ALIASES).flatMap(([alias, target]) => {
    const def = defs.find((item) => item.id === target)
    if (!def) return []
    const input = schemaToTs(z.toJSONSchema(def.parameters))
    return [
      `### \`${alias}\`\nAlias for ${target}. ${def.description.trim()}\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { ${alias}(args: ${input}): Promise<unknown>; };\n\`\`\``,
    ]
  })
  return [...sections, ...aliasSections].join("\n\n")
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
const __attachments = [];
const text = (value) => __text(__fmt(value));
const __dataAttachment = (value, kind) => {
  let url;
  let mime;
  if (typeof value === "string") url = value;
  else if (value && typeof value === "object" && typeof value.data === "string" && typeof value.mimeType === "string") {
    mime = value.mimeType;
    url = "data:" + mime + ";base64," + value.data;
  } else if (value && typeof value === "object") {
    url = kind === "image" ? value.image_url : value.audio_url;
  }
  if (typeof url !== "string" || !url.startsWith("data:")) throw new Error(kind + " expects a base64-encoded data URL");
  mime = mime || /^data:([^;,]+)/.exec(url)?.[1] || (kind === "image" ? "image/png" : "audio/mpeg");
  __attachments.push({ type: "file", mime, url });
};
const image = (value) => __dataAttachment(value, "image");
const audio = (value) => __dataAttachment(value, "audio");
const generatedImage = (result) => {
  __dataAttachment(result && result.image_url, "image");
  if (result && result.output_hint) text(result.output_hint);
};
const exit = () => { throw { __codeModeExit: true }; };
const store = (key, value) => __store(String(key), value);
const load = (key) => __load(String(key));
const notify = (value) => __notify(__fmt(value));
let __timerID = 0;
const __timers = new Map();
const setTimeout = (callback, delayMs = 0) => {
  const id = ++__timerID;
  __timers.set(id, true);
  __sleep(Math.max(0, Number(delayMs) || 0)).then(() => {
    if (!__timers.delete(id)) return;
    callback();
  });
  return id;
};
const clearTimeout = (id) => { __timers.delete(id); };
const yield_control = () => __yieldControl();
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
      if (!lenient) warn("Error at " + at() + " serialized as {name, message}");
      return { name: v.name, message: v.message };
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
    const agents = yield* Agent.Service
    const executeScript = (
      params: z.infer<typeof Parameters>,
      ctx: Tool.Context,
      output: ReturnType<typeof createCodeModeOutputBuffer>,
    ) =>
        Effect.gen(function* () {
          const maxToolCalls = params.max_tool_calls ?? MAX_TOOL_CALLS_DEFAULT
          const activeDeadlineMs = params.timeout ?? ACTIVE_DEADLINE_MS_DEFAULT
          const trace: TraceEntry[] = []
          // completeToolCall REPLACES part metadata with execute()'s return value,
          // so every terminal return re-publishes these counts — otherwise the
          // per-tool breakdown vanishes the instant the run finishes.
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
          if (Buffer.byteLength(params.code, "utf8") > MAX_CODE_BYTES) {
            return {
              title: "code too large",
              metadata: { status: "code_error", toolCalls: 0, counts: tally(), recent: recentTail() },
              output: `<exec status="code_error">\n<error_message>\ncode exceeds ${MAX_CODE_BYTES} bytes\n</error_message>\n</exec>`,
            }
          }

          const getDefs = toolScriptRegistry.current
          if (!getDefs) throw new Error("exec tool registry unavailable")
          const agentInfo = yield* agents.get(ctx.agent)
          const model = ctx.extra?.model as { id: ModelID; providerID: ProviderID } | undefined
          const whitelist = Array.isArray(ctx.extra?.toolWhitelist)
            ? new Set(ctx.extra.toolWhitelist.filter((id): id is string => typeof id === "string"))
            : undefined
          const defs = (
            yield* getDefs(
              model
                ? { providerID: model.providerID, modelID: model.id, agent: agentInfo }
                : undefined,
            )
          ).filter(
            (def) =>
              !NOT_CALLABLE_IN_EXEC.has(def.id) &&
              (!whitelist ||
                whitelist.has(def.id) ||
                Object.entries(TOOL_SCRIPT_ALIASES).some(
                  ([alias, target]) => target === def.id && whitelist.has(alias),
                )),
          )
          const byId = new Map(defs.map((def) => [def.id, def]))
          // Request-authorized MCP tools (delivered via ctx.extra.execMcp and
          // filled by SessionPrompt's resolveTools for THIS request). Tool Search
          // only limits the outer model's schema list; exec receives the full
          // authorized view so it can call tools[exactCatalogName](...) directly.
          // A module-level ref would be overwritten by concurrent sessions.
          // Builtin ids win on collision — an MCP server must not shadow `read`.
          const mcpTools = (ctx.extra?.execMcp as { current?: Record<string, AiTool> } | undefined)?.current ?? {}
          const reservedNames = new Set([
            ...Object.keys(TOOL_SCRIPT_ALIASES),
            ...[...byId.keys()],
            ...[...byId.keys()].map(normalizeCodeModeIdentifier),
          ])
          const mcpById = new Map(
            Object.entries(mcpTools).filter(
              ([id]) =>
                !reservedNames.has(id) &&
                !reservedNames.has(normalizeCodeModeIdentifier(id)) &&
                (!whitelist || whitelist.has(id)),
            ),
          )
          const allTools = [
            ...[...byId.values()].map((def) => ({
              name: normalizeCodeModeIdentifier(def.id),
              description: def.description,
            })),
            ...Object.entries(TOOL_SCRIPT_ALIASES).flatMap(([name, target]) => {
              const def = byId.get(target)
              if (!def) return []
              return [{ name, description: `Alias for ${target}. ${def.description}` }]
            }),
            ...[...mcpById.entries()].map(([name, tool]) => ({
              name: normalizeCodeModeIdentifier(name),
              description: tool.description ?? "",
            })),
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
          const source = `globalThis.__main = async () => {\n${params.code}\n}`
          const result = ts.transpileModule(source, {
            reportDiagnostics: true,
            compilerOptions: {
              module: ts.ModuleKind.ESNext,
              target: ts.ScriptTarget.ESNext,
            },
          })
          const hasImport = /^\s*(import|export)\s/m.test(params.code)
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
              metadata: { status: "code_error", toolCalls: 0, counts: tally(), recent: recentTail() },
              output: `<exec status="code_error">\n<error_message>\n${formatDiagnostics(result.diagnostics ?? [])}\n</error_message>\n</exec>`,
            }
          }
          const transpiled = result.outputText

          let logBytes = 0
          let calls = 0
          const withSlot = makeSemaphore(MAX_CONCURRENT)

          // Live progress for the TUI: after each settled call, publish the
          // aggregated per-tool counts plus a bounded tail of per-call trace
          // entries through the OUTER part's metadata (each ctx.metadata fires
          // a part delta the ToolScript view renders reactively). The tail is
          // capped so metadata deltas stay small on 500-call runs.
          // Fire-and-forget — progress must never fail a call.
          const publishProgress = () => {
            bridge
              .promise(
                ctx.metadata({
                  metadata: { running: true, toolCalls: trace.length, counts: tally(), recent: recentTail() },
                }),
              )
              .catch(() => {})
          }

          const callTool: HostFn = (name: unknown, args: unknown) => {
            const id = String(name)
            const alias = TOOL_SCRIPT_ALIASES[id as keyof typeof TOOL_SCRIPT_ALIASES]
            const def = byId.get(alias ?? id) ?? [...byId.values()].find((item) => normalizeCodeModeIdentifier(item.id) === id)
            const mcpDef = def
              ? undefined
              : (mcpById.get(id) ??
                [...mcpById.entries()].find(([name]) => normalizeCodeModeIdentifier(name) === id)?.[1])
            if (!def && !mcpDef) return Promise.reject(new Error(`unknown tool: ${id}`))
            calls++
            if (calls > maxToolCalls)
              return Promise.reject(new Error(`tool call budget exceeded (${maxToolCalls} per execution)`))
            const seq = calls
            const start = Date.now()
            const subCtx = {
              ...ctx,
              callID: `${ctx.callID ?? "exec"}:${seq}`,
              // Sub-call metadata would clobber the outer exec call's
              // title in the UI — swallow it; the trace covers observability.
              metadata: () => Effect.void,
            }
            // MCP path: the map holds SessionPrompt's WRAPPED executes, so the
            // full direct-call pipeline applies unchanged — permission ask,
            // plugin before/after hooks, metrics, normalizeToolResult folding,
            // truncation. Here we only adapt the wrapped result shape for the
            // guest: structuredContent (when the server sent it) crosses as a
            // parsed value under `structured` so scripts can filter/aggregate
            // without re-parsing text; media attachments from the nested call
            // are not represented in this adapter and are dropped with a note.
            const executeMcp = (tool: AiTool) =>
              Effect.tryPromise({
                try: () =>
                  Promise.resolve(
                    tool.execute!(args ?? {}, {
                      toolCallId: subCtx.callID,
                      messages: [],
                      abortSignal: ctx.abort,
                    }),
                  ),
                catch: (err) => (err instanceof Error ? err : new Error(String(err))),
              }).pipe(
                Effect.map((result) => {
                  const r = result as {
                    output?: unknown
                    metadata?: { mcp?: { isError?: boolean; structuredContent?: unknown; _meta?: Record<string, unknown> } }
                    attachments?: unknown[]
                  }
                  const structured = r?.metadata?.mcp?.structuredContent
                  const dropped = Array.isArray(r?.attachments) && r.attachments.length
                    ? `\n[note: ${r.attachments.length} non-text attachment(s) dropped before the nested result entered the exec isolate]`
                    : ""
                  return {
                    title: id,
                    output: String(r?.output ?? "") + dropped,
                    metadata: (r?.metadata ?? {}) as Record<string, unknown>,
                    content: [{ type: "text", text: String(r?.output ?? "") }],
                    isError: r?.metadata?.mcp?.isError,
                    _meta: r?.metadata?.mcp?._meta,
                    ...(structured !== undefined && { structured }),
                    ...(structured !== undefined && { structuredContent: structured }),
                  }
                }),
              )
            return withSlot(() =>
              bridge
                .promise(
                  def
                    ? def.execute(def.id === "apply_patch" && typeof args === "string" ? { patch_text: args } : args, subCtx)
                    : executeMcp(mcpDef!),
                )
                .then(
                  (result) => {
                    trace.push({ name: id, status: "success", durationMs: Date.now() - start })
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
            output.append(`${logBytes >= MAX_LOG_BYTES ? text.slice(0, 200) + " …(log budget exhausted)" : text}\n`)
            return undefined
          }
          const textHook: HostFn = (value: unknown) => {
            output.append(`${String(value)}\n`)
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
          const pendingStoreWrites = new Map<string, unknown>()
          const storeValue: HostFn = (key: unknown, value: unknown) => {
            pendingStoreWrites.set(String(key), value)
            return undefined
          }
          const loadValue: HostFn = (key: unknown) => {
            const name = String(key)
            if (pendingStoreWrites.has(name)) return pendingStoreWrites.get(name)
            return sessionStore(ctx.sessionID).get(name)
          }
          const notifyValue: HostFn = (value: unknown) => {
            bridge
              .promise(ctx.metadata({ metadata: { running: true, notification: String(value) } }))
              .catch(() => {})
            return undefined
          }
          const sleep: HostFn = (delay: unknown) =>
            new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delay) || 0)))
          const yieldControl: HostFn = () => {
            output.yield()
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
                  `\nlet __ret;
try { __ret = await globalThis.__main(); }
catch (e) { if (!e || e.__codeModeExit !== true) throw e; }
const __out = __serialize(__ret, false);
return { __undef: __out.value === undefined, json: __out.value === undefined ? "" : JSON.stringify(__out.value), warnings: __out.warnings, attachments: __attachments };`,
                {
                __callTool: callTool,
                __log: logHook,
                __text: textHook,
                __readText: readText,
                __writeText: writeText,
                __store: storeValue,
                __load: loadValue,
                __notify: notifyValue,
                __sleep: sleep,
                __yieldControl: yieldControl,
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
            return {
              title: status,
              metadata: { status, toolCalls: trace.length, counts: tally(), recent: recentTail() },
              output: `<exec status="${status}">\n<error_message>\n${explained}\n</error_message>\n${traceBlock}</exec>`,
            }
          }

          // Keep top-level return for backward compatibility, but emit it directly
          // rather than inventing a `<return_value>` content channel. `text()` and
          // console output have already streamed through the cell output buffer.
          const envelope = outcome.success as {
            __undef: boolean
            json: string
            warnings: string[]
            attachments: Array<{ type: "file"; mime: string; url: string }>
          }
          const parsed = envelope.__undef ? undefined : (JSON.parse(envelope.json) as unknown)
          const returnedText =
            parsed === undefined ? "" : typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)
          const warningsBlock = envelope.warnings.length
            ? `<warnings>\n${envelope.warnings.map((w) => `- ${w}`).join("\n")}\n</warnings>\n`
            : ""
          const returnedBytes = Buffer.byteLength(returnedText, "utf8")
          if (returnedBytes > MAX_RESULT_BYTES) {
            return {
              title: "result too large",
              metadata: { status: "budget_exceeded", toolCalls: trace.length, counts: tally(), recent: recentTail() },
              output: `<exec status="budget_exceeded">\n<error_message>\nreturned value is ${returnedBytes} bytes (max ${MAX_RESULT_BYTES}). Aggregate or slice the data before returning.\n</error_message>\n${warningsBlock}${traceBlock}</exec>`,
            }
          }

          if (pendingStoreWrites.size > 0) {
            const committed = sessionStore(ctx.sessionID)
            pendingStoreWrites.forEach((value, key) => committed.set(key, value))
          }
          return {
            title: `${trace.length} tool calls`,
            metadata: { status: "completed", toolCalls: trace.length, counts: tally(), recent: recentTail() },
            output: [returnedText, warningsBlock, traceBlock].filter(Boolean).join("\n"),
            attachments: envelope.attachments,
          }
        }).pipe(Effect.orDie)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      freeform: {
        format: {
          type: "grammar" as const,
          syntax: "lark" as const,
          definition: CODE_MODE_EXEC_GRAMMAR,
        },
        parse: parseExecSource,
      },
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const controller = new AbortController()
          if (ctx.abort.aborted) controller.abort()
          const abort = () => controller.abort()
          ctx.abort.addEventListener("abort", abort, { once: true })
          const output = createCodeModeOutputBuffer()
          const promise = bridge.promise(executeScript(params, { ...ctx, abort: controller.signal }, output))
          promise.finally(() => ctx.abort.removeEventListener("abort", abort)).catch(() => {})
          return yield* Effect.promise(() =>
            startCell({
              sessionID: ctx.sessionID,
              promise,
              controller,
              output,
              yieldTimeMs: params.yield_time_ms,
              maxTokens: params.max_output_tokens,
            }),
          )
        }).pipe(Effect.orDie),
    }
  }),
)
