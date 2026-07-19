import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import SHELL_DESCRIPTION from "./task.shell.txt"
import { tokenize } from "./shell-tokenize"
import z from "zod"
import { Effect } from "effect"
import { TaskRegistry } from "@/task/registry"
import type { SessionID } from "../session/schema"

const KNOWN_VERBS = [
  "create",
  "list",
  "get",
  "start",
  "block",
  "unblock",
  "done",
  "abandon",
  "rename",
]

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function suggestVerb(input: string): string | undefined {
  const candidates = KNOWN_VERBS.map((v) => ({ v, d: levenshtein(input, v) })).filter((c) => c.d <= 2)
  if (candidates.length !== 1) return undefined
  return candidates[0].v
}

const id = "task"

const statusSchema = z.enum(["open", "in_progress", "blocked", "done", "abandoned"])

const createOperation = z.strictObject({
  action: z.literal("create"),
  summary: z.string().min(1).describe("Task summary for a single task."),
  parent_id: z.string().min(1).optional().describe("Parent task id for sub-tasks."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const listOperation = z.strictObject({
  action: z.literal("list"),
  status: statusSchema.optional().describe("Filter by status."),
  include_terminal: z.boolean().optional().describe("Include done/abandoned tasks. Default false."),
  include_archived: z.boolean().optional().describe("Include archived tasks. Default false."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const getOperation = z.strictObject({
  action: z.literal("get"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const startOperation = z.strictObject({
  action: z.literal("start"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  event_summary: z.string().min(1).optional().describe("Short note on starting."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const blockOperation = z.strictObject({
  action: z.literal("block"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  event_summary: z.string().min(1).optional().describe("Short reason for blocking."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const unblockOperation = z.strictObject({
  action: z.literal("unblock"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  event_summary: z.string().min(1).optional().describe("Short reason for unblocking."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const doneOperation = z.strictObject({
  action: z.literal("done"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  event_summary: z.string().min(1).optional().describe("Short summary of what was completed."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const abandonOperation = z.strictObject({
  action: z.literal("abandon"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  event_summary: z.string().min(1).optional().describe("Short reason for abandoning."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const renameOperation = z.strictObject({
  action: z.literal("rename"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  summary: z.string().min(1).describe("New task summary."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const parameters = z.strictObject({
  // .meta({ type: "object" }) is REQUIRED — without it, the emitted JSON
  // schema's `operation` node has only `anyOf`, no `type`. Some models
  // (notably mimo-v2.5-pro) then stringify the entire envelope, producing
  // {"operation":"{\"action\":\"create\",...}"} which fails zod validation.
  // See research-tool-call-schema/REPORT.md §2.5 "success-nested" warning.
  operation: z
    .discriminatedUnion("action", [
      createOperation,
      listOperation,
      getOperation,
      startOperation,
      blockOperation,
      unblockOperation,
      doneOperation,
      abandonOperation,
      renameOperation,
    ])
    .meta({ type: "object" }),
})

type TaskInput = z.infer<typeof parameters>
type TaskOperation = TaskInput
type TaskStatus = z.infer<typeof statusSchema>

type Metadata = {
  id?: string
  status?: string
  ids?: string[]
  count?: number
}

function parseTaskScript(script: string): Effect.Effect<TaskOperation[], unknown> {
  return Effect.gen(function* () {
    const argvList = yield* tokenize(script)
    const out: TaskOperation[] = []
    for (const argv of argvList) {
      const [head, verb, ...rest] = argv.tokens
      if (head !== "task") {
        return yield* Effect.fail({
          kind: "unknown-verb",
          line: argv.line,
          detail: `task: every command must start with 'task' (got '${head ?? ""}')`,
        })
      }
      const parsed = yield* mapVerb(verb, rest, argv.line)
      out.push(parsed)
    }
    return out
  })
}

// Recover a shell-mode task call shaped like the JSON args (no `script`):
// a stringified/nested `operation`, or the common bare `{summary}` create.
// Conservative — only the unambiguous create-from-summary is synthesized;
// anything else passes through (nested) or returns undefined (→ teach JSON).
export function recoverTaskArgs(rawArgs: unknown): TaskOperation | undefined {
  if (rawArgs == null || typeof rawArgs !== "object") return undefined
  let obj = rawArgs as Record<string, unknown>
  if (typeof obj.operation === "string") {
    try {
      const inner = JSON.parse(obj.operation)
      if (inner && typeof inner === "object" && !Array.isArray(inner)) obj = { operation: inner }
    } catch {}
  }
  if (obj.operation && typeof obj.operation === "object" && !Array.isArray(obj.operation))
    return { operation: obj.operation } as TaskOperation
  if (typeof obj.summary === "string") {
    const op: Record<string, unknown> = { action: "create", summary: obj.summary }
    if (typeof obj.parent_id === "string") op.parent_id = obj.parent_id
    if (typeof obj.session_id === "string") op.session_id = obj.session_id
    return { operation: op } as TaskOperation
  }
  return undefined
}

// Extract a fixed set of `--name value` / `--name=value` string flags and
// boolean presence flags from a verb's args, leaving positionals in `rest`.
// Synchronous (task's mapVerb is sync, unlike actor's Effect-returning extractor).
// A value flag with no value (`--session` at end, or `--session=`) sets `error`
// rather than silently dropping — mirrors actor's extractNamedFlags contract so a
// dangling flag never swallows a positional into a confusing arity error.
function extractTaskFlags(
  args: string[],
  valueFlags: string[],
  boolFlags: string[],
): { flags: Record<string, string>; bools: Record<string, boolean>; rest: string[]; error?: string } {
  const rest: string[] = []
  const flags: Record<string, string> = {}
  const bools: Record<string, boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const boolName = boolFlags.find((n) => a === `--${n}`)
    if (boolName) {
      bools[boolName] = true
      continue
    }
    const valName = valueFlags.find((n) => a === `--${n}`)
    if (valName) {
      const next = args[i + 1]
      if (next === undefined) return { flags, bools, rest, error: `--${valName} requires a value` }
      flags[valName] = next
      i++
      continue
    }
    const eq = valueFlags.find((n) => a.startsWith(`--${n}=`))
    if (eq) {
      const v = a.slice(`--${eq}=`.length)
      if (v === "") return { flags, bools, rest, error: `--${eq} requires a value` }
      flags[eq] = v
      continue
    }
    rest.push(a)
  }
  return { flags, bools, rest }
}

function flagError(verb: string, detail: string, line: number) {
  return Effect.fail({ kind: "flag", line, detail: `task: ${verb}: ${detail}` })
}

function mapVerb(verb: string | undefined, args: string[], line: number): Effect.Effect<TaskOperation, unknown> {
  switch (verb) {
    case "create": {
      const { flags, rest, error } = extractTaskFlags(args, ["parent", "session"], [])
      if (error) return flagError("create", error, line)
      if (rest.length !== 1) return arityError("create", '<summary> [--parent <TID>] [--session <id>]', rest, line)
      return Effect.succeed({
        operation: {
          action: "create" as const,
          summary: rest[0],
          ...(flags.parent ? { parent_id: flags.parent } : {}),
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "list": {
      const { flags, bools, rest, error } = extractTaskFlags(args, ["session"], ["include-terminal", "include-archived"])
      if (error) return flagError("list", error, line)
      if (rest.length > 1) return arityError("list", "[<status>] [--include-terminal] [--include-archived] [--session <id>]", rest, line)
      return Effect.succeed({
        operation: {
          action: "list" as const,
          ...(rest.length === 1 ? { status: rest[0] as TaskStatus } : {}),
          ...(bools["include-terminal"] ? { include_terminal: true } : {}),
          ...(bools["include-archived"] ? { include_archived: true } : {}),
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "get": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("get", error, line)
      if (rest.length !== 1) return arityError("get", "<id> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "get" as const, id: rest[0], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "start": {
      const { flags, rest, error } = extractTaskFlags(args, ["reason", "session"], [])
      if (error) return flagError("start", error, line)
      if (rest.length !== 1) return arityError("start", "<id> [--reason <note>] [--session <id>]", rest, line)
      return Effect.succeed({
        operation: {
          action: "start" as const,
          id: rest[0],
          ...(flags.reason ? { event_summary: flags.reason } : {}),
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "block": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("block", error, line)
      if (rest.length !== 2) return arityError("block", "<id> <reason> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "block" as const, id: rest[0], event_summary: rest[1], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "unblock": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("unblock", error, line)
      if (rest.length !== 2) return arityError("unblock", "<id> <reason> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "unblock" as const, id: rest[0], event_summary: rest[1], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "done": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("done", error, line)
      if (rest.length !== 2) return arityError("done", "<id> <summary> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "done" as const, id: rest[0], event_summary: rest[1], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "abandon": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("abandon", error, line)
      if (rest.length !== 2) return arityError("abandon", "<id> <reason> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "abandon" as const, id: rest[0], event_summary: rest[1], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "rename": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("rename", error, line)
      if (rest.length !== 2) return arityError("rename", "<id> <summary> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "rename" as const, id: rest[0], summary: rest[1], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    default: {
      const suggestion = suggestVerb(verb ?? "")
      const detail =
        `task: unknown verb "${verb ?? ""}"\n` +
        `  available verbs: ${KNOWN_VERBS.join(", ")}` +
        (suggestion ? `\n  did you mean: ${suggestion}?` : "")
      return Effect.fail({ kind: "unknown-verb", line, detail })
    }
  }
}

function arityError(verb: string, expected: string, args: string[], line: number) {
  return Effect.fail({
    kind: "arity",
    line,
    detail: `task: ${verb}: arity mismatch\n  got:      task ${verb} ${args.join(" ")}\n  expected: task ${verb} ${expected}`,
  })
}

export const TaskTool = Tool.define<typeof parameters, Metadata, TaskRegistry.Service>(
  id,
  Effect.gen(function* () {
    const reg = yield* TaskRegistry.Service

    const run = Effect.fn("TaskTool.execute")(function* (input: TaskInput, ctx: Tool.Context<Metadata>) {
      const op = input.operation
      const sessionID = (op.session_id || ctx.sessionID) as SessionID

      if (op.action === "create") {
        const t = yield* reg.create({
          session_id: sessionID,
          summary: op.summary,
          parent_id: op.parent_id || undefined,
          owner: ctx.actorID ?? ctx.agent,
        })
        return {
          title: `Task created: ${t.id}`,
          output: `Created ${t.id} (${t.status}): ${t.summary}`,
          metadata: { id: t.id, status: t.status } as Metadata,
        }
      }

      if (op.action === "list") {
        const tasks = yield* reg.list({
          session_id: sessionID,
          status: op.status,
          include_terminal: op.include_terminal,
          include_archived: op.include_archived,
        })
        const lines =
          tasks.length === 0
            ? ["No tasks."]
            : tasks.map((t) => {
                return `${t.id} ${t.status} — ${t.summary}`
              })
        return {
          title: `Tasks: ${tasks.length}`,
          output: lines.join("\n"),
          metadata: { count: tasks.length, ids: tasks.map((t) => t.id) } as Metadata,
        }
      }

      if (op.action === "get") {
        const t = yield* reg.get({ session_id: sessionID, id: op.id })
        if (!t)
          return {
            title: `Task ${op.id}: not found`,
            output: `No task ${op.id}. Use \`task list\` to see valid task IDs.`,
            metadata: {} as Metadata,
          }
        return {
          title: `Task ${op.id}: ${t.status}`,
          output: JSON.stringify(t, null, 2),
          metadata: { id: t.id, status: t.status } as Metadata,
        }
      }

      if (op.action === "start") {
        // A subagent starting a task owned by someone else must NOT steal
        // ownership: the completion gate filters by owner, so an accidental
        // handoff traps the subagent in "finish tasks you own" re-entry for
        // tasks that belong to the main agent. Intentional handoff stays
        // available to internal callers (actor auto-start in spawn.ts).
        const caller = ctx.actorID ?? ctx.agent
        const existing = yield* reg.get({ session_id: sessionID, id: op.id })
        const isSubagent = ctx.actorID !== undefined && ctx.actorID !== "main"
        const keepOwner = isSubagent && existing?.owner != null && existing.owner !== caller
        const result = yield* reg.start({ session_id: sessionID, id: op.id, owner: keepOwner ? undefined : caller, event_summary: op.event_summary })
        return {
          title: `Task ${op.id}: ${result.status}`,
          output: `start → ${result.status}`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "block") {
        const result = yield* reg.block({ session_id: sessionID, id: op.id, event_summary: op.event_summary })
        return {
          title: `Task ${op.id}: blocked`,
          output: `block → ${result.status}`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "unblock") {
        const result = yield* reg.unblock({ session_id: sessionID, id: op.id, event_summary: op.event_summary })
        return {
          title: `Task ${op.id}: ${result.status}`,
          output: `unblock → ${result.status}`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "done") {
        const result = yield* reg.done({ session_id: sessionID, id: op.id, event_summary: op.event_summary })
        return {
          title: `Task ${op.id}: done`,
          output: `done → ${result.status}`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "abandon") {
        const result = yield* reg.abandon({ session_id: sessionID, id: op.id, event_summary: op.event_summary })
        return {
          title: `Task ${op.id}: abandoned`,
          output: `abandon → ${result.status}`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "rename") {
        const result = yield* reg.rename({ session_id: sessionID, id: op.id, summary: op.summary })
        return {
          title: `Task ${op.id}: renamed`,
          output: `rename → "${result.summary}"`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      return yield* Effect.fail(new Error(`Unknown operation: ${(op as { action: string }).action}`))
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (args: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
        run(args, ctx).pipe(Effect.orDie),
      shell: {
        description: SHELL_DESCRIPTION,
        parse: parseTaskScript,
        recover: recoverTaskArgs,
      },
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
