import * as Tool from "./tool"
import DESCRIPTION from "./cron.txt"
import SHELL_DESCRIPTION from "./cron.shell.txt"
import { tokenize } from "./shell-tokenize"
import z from "zod"
import { Effect } from "effect"
import { Scheduler } from "@/cron/scheduler"
import { computeNextCronRun } from "@/cron/cron-expr"
import type { SessionID } from "../session/schema"

const KNOWN_VERBS = ["schedule", "loop", "list", "get", "delete", "cancel", "rename"]
const VERB_ALIASES: Record<string, string> = { cancel: "delete" }

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

const id = "cron"

const sessionFlag = z.string().min(1).optional().describe("Session id to act on. Defaults to current session.")
const kindSchema = z.enum(["cron", "loop"])

const scheduleOperation = z.strictObject({
  action: z.literal("schedule"),
  cron: z.string().min(1).describe("5-field cron expression (minute hour dom month dow)."),
  prompt: z.string().min(1).describe("Prompt to send to the agent when the job fires."),
  one_shot: z.boolean().optional().describe("If true, run once and remove."),
  durable: z.boolean().optional().describe("If true, persist across session restart."),
  session_id: sessionFlag,
})

const loopOperation = z.strictObject({
  action: z.literal("loop"),
  delay_seconds: z.number().int().min(1).max(86_400).describe("Delay before next fire; clamped to [60, 3600] by scheduler."),
  prompt: z.string().min(1).describe("Loop body prompt; identifies the loop across turns."),
  reason: z.string().min(1).optional().describe("Why this loop is being armed/extended."),
  session_id: sessionFlag,
})

const listOperation = z.strictObject({
  action: z.literal("list"),
  kind: kindSchema.optional().describe("Filter by job kind."),
  durable_only: z.boolean().optional().describe("Only show durable jobs."),
  session_id: sessionFlag,
})

const getOperation = z.strictObject({
  action: z.literal("get"),
  id: z.string().min(1).describe("Job id returned by schedule/list."),
  session_id: sessionFlag,
})

const deleteOperation = z.strictObject({
  action: z.literal("delete"),
  id: z.string().min(1).describe("Job id to cancel."),
  session_id: sessionFlag,
})

const renameOperation = z.strictObject({
  action: z.literal("rename"),
  id: z.string().min(1).describe("Job id whose prompt body to replace."),
  prompt: z.string().min(1).describe("New prompt body."),
  session_id: sessionFlag,
})

const parameters = z.strictObject({
  // .meta({ type: "object" }) is REQUIRED — without it, the emitted JSON
  // schema's `operation` node has only `anyOf`, no `type`. Some models
  // then stringify the entire envelope; see task.ts:117 for full context.
  operation: z
    .discriminatedUnion("action", [
      scheduleOperation,
      loopOperation,
      listOperation,
      getOperation,
      deleteOperation,
      renameOperation,
    ])
    .meta({ type: "object" }),
})

type CronInput = z.infer<typeof parameters>
type CronOperation = CronInput

type Metadata = {
  id?: string
  kind?: string
  count?: number
  ids?: string[]
  aged_out?: boolean
  scheduled_for?: number
}

function parseCronScript(script: string): Effect.Effect<CronOperation[], unknown> {
  return Effect.gen(function* () {
    const argvList = yield* tokenize(script)
    const out: CronOperation[] = []
    for (const argv of argvList) {
      const [head, verb, ...rest] = argv.tokens
      if (head !== "cron") {
        return yield* Effect.fail({
          kind: "unknown-verb",
          line: argv.line,
          detail: `cron: every command must start with 'cron' (got '${head ?? ""}')`,
        })
      }
      const parsed = yield* mapVerb(verb, rest, argv.line)
      out.push(parsed)
    }
    return out
  })
}

// Recover a shell-mode cron call shaped like the JSON args (no `script`):
// a stringified/nested `operation`, or the common bare `{cron, prompt}` schedule.
// Conservative — only the unambiguous schedule-from-{cron,prompt} is synthesized;
// anything else passes through (nested) or returns undefined (→ teach JSON).
export function recoverCronArgs(rawArgs: unknown): CronOperation | undefined {
  if (rawArgs == null || typeof rawArgs !== "object") return undefined
  let obj = rawArgs as Record<string, unknown>
  if (typeof obj.operation === "string") {
    try {
      const inner = JSON.parse(obj.operation)
      if (inner && typeof inner === "object" && !Array.isArray(inner)) obj = { operation: inner }
    } catch {}
  }
  if (obj.operation && typeof obj.operation === "object" && !Array.isArray(obj.operation))
    return { operation: obj.operation } as CronOperation
  if (typeof obj.cron === "string" && typeof obj.prompt === "string") {
    const op: Record<string, unknown> = { action: "schedule", cron: obj.cron, prompt: obj.prompt }
    if (typeof obj.one_shot === "boolean") op.one_shot = obj.one_shot
    if (typeof obj.durable === "boolean") op.durable = obj.durable
    if (typeof obj.session_id === "string") op.session_id = obj.session_id
    return { operation: op } as CronOperation
  }
  return undefined
}

// Extract a fixed set of `--name value` / `--name=value` string flags and
// boolean presence flags, leaving positionals in `rest`. Mirrors task.ts's
// extractTaskFlags exactly so a dangling value flag never swallows a positional.
function extractCronFlags(
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
  return Effect.fail({ kind: "flag", line, detail: `cron: ${verb}: ${detail}` })
}

function arityError(verb: string, expected: string, args: string[], line: number) {
  return Effect.fail({
    kind: "arity",
    line,
    detail: `cron: ${verb}: arity mismatch\n  got:      cron ${verb} ${args.join(" ")}\n  expected: cron ${verb} ${expected}`,
  })
}

function mapVerb(rawVerb: string | undefined, args: string[], line: number): Effect.Effect<CronOperation, unknown> {
  const verb = rawVerb ? (VERB_ALIASES[rawVerb] ?? rawVerb) : undefined
  switch (verb) {
    case "schedule": {
      const { flags, bools, rest, error } = extractCronFlags(args, ["session"], ["one-shot", "durable"])
      if (error) return flagError("schedule", error, line)
      if (rest.length !== 2)
        return arityError("schedule", "<cron-expr> <prompt> [--one-shot] [--durable] [--session <id>]", rest, line)
      return Effect.succeed({
        operation: {
          action: "schedule" as const,
          cron: rest[0],
          prompt: rest[1],
          ...(bools["one-shot"] ? { one_shot: true } : {}),
          ...(bools.durable ? { durable: true } : {}),
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "loop": {
      const { flags, rest, error } = extractCronFlags(args, ["reason", "session"], [])
      if (error) return flagError("loop", error, line)
      if (rest.length !== 2)
        return arityError("loop", "<delay-seconds> <prompt> [--reason <text>] [--session <id>]", rest, line)
      const delay = Number.parseInt(rest[0], 10)
      if (!Number.isFinite(delay) || delay <= 0)
        return arityError("loop", "<delay-seconds> must be a positive integer", rest, line)
      return Effect.succeed({
        operation: {
          action: "loop" as const,
          delay_seconds: delay,
          prompt: rest[1],
          ...(flags.reason ? { reason: flags.reason } : {}),
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "list": {
      const { flags, bools, rest, error } = extractCronFlags(args, ["kind", "session"], ["durable-only"])
      if (error) return flagError("list", error, line)
      if (rest.length > 0)
        return arityError("list", "[--kind cron|loop] [--durable-only] [--session <id>]", rest, line)
      if (flags.kind && flags.kind !== "cron" && flags.kind !== "loop")
        return flagError("list", `--kind must be cron|loop (got '${flags.kind}')`, line)
      return Effect.succeed({
        operation: {
          action: "list" as const,
          ...(flags.kind ? { kind: flags.kind as "cron" | "loop" } : {}),
          ...(bools["durable-only"] ? { durable_only: true } : {}),
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "get": {
      const { flags, rest, error } = extractCronFlags(args, ["session"], [])
      if (error) return flagError("get", error, line)
      if (rest.length !== 1) return arityError("get", "<id> [--session <id>]", rest, line)
      return Effect.succeed({
        operation: {
          action: "get" as const,
          id: rest[0],
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "delete": {
      const { flags, rest, error } = extractCronFlags(args, ["session"], [])
      if (error) return flagError("delete", error, line)
      if (rest.length !== 1) return arityError("delete", "<id> [--session <id>]", rest, line)
      return Effect.succeed({
        operation: {
          action: "delete" as const,
          id: rest[0],
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "rename": {
      const { flags, rest, error } = extractCronFlags(args, ["session"], [])
      if (error) return flagError("rename", error, line)
      if (rest.length !== 2) return arityError("rename", "<id> <prompt> [--session <id>]", rest, line)
      return Effect.succeed({
        operation: {
          action: "rename" as const,
          id: rest[0],
          prompt: rest[1],
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    default: {
      const suggestion = suggestVerb(rawVerb ?? "")
      const detail =
        `cron: unknown verb "${rawVerb ?? ""}"\n` +
        `  available verbs: ${KNOWN_VERBS.join(", ")}` +
        (suggestion ? `\n  did you mean: ${suggestion}?` : "")
      return Effect.fail({ kind: "unknown-verb", line, detail })
    }
  }
}

export { parseCronScript }

export const CronTool = Tool.define<typeof parameters, Metadata, Scheduler>(
  id,
  Effect.gen(function* () {
    const scheduler = yield* Scheduler

    const run = Effect.fn("CronTool.execute")(function* (input: CronInput, ctx: Tool.Context<Metadata>) {
      const op = input.operation
      const sessionID = (op.session_id || ctx.sessionID) as SessionID

      if (op.action === "schedule") {
        const t = yield* scheduler.add({
          session_id: sessionID,
          cron: op.cron,
          prompt: op.prompt,
          recurring: !op.one_shot,
          durable: op.durable ?? false,
        })
        // Sanity-check the cron: warn on two shapes the user is unlikely to
        // want, both of which the parser/scheduler will otherwise accept
        // silently.
        //   (a) The expression never matches within a year (e.g. `0 0 30 2 *`
        //       — Feb 30). computeNextCronRun returns null; the task will sit
        //       on disk forever, never firing. Always worth surfacing.
        //   (b) A ONE-SHOT expression whose next fire is > 30 days away. This
        //       is the "past-date pinned cron silently rolls to next year"
        //       shape the PR called out — user typed a specific date, cron's
        //       forward-only semantics rolled it to the next matching window.
        //       A RECURRING expression legitimately targets far-future fires
        //       (`0 0 1 1 *` = yearly Jan 1) so no warning there.
        const nextRun = computeNextCronRun(op.cron, new Date())
        const monthMs = 30 * 24 * 60 * 60 * 1000
        let warning = ""
        if (nextRun === null) {
          warning =
            `\n⚠ this cron expression never matches within a year — the task is scheduled but will never fire. Double-check the fields (e.g. \`0 0 30 2 *\` = Feb 30, which doesn't exist).`
        } else if (op.one_shot && nextRun.getTime() - Date.now() > monthMs) {
          warning =
            `\n⚠ next fire is ${nextRun.toISOString()} — cron's forward-only semantics rolled this one-shot to the next matching window. If you meant sooner, cancel and re-schedule with a date in the future.`
        }
        return {
          title: `Scheduled ${t.id}`,
          output: `Scheduled ${t.id} (${op.cron}${op.one_shot ? ", one-shot" : ", recurring"}${op.durable ? ", durable" : ""}): ${op.prompt}${warning}`,
          metadata: {
            id: t.id,
            kind: t.kind ?? "cron",
            ...(nextRun ? { scheduled_for: nextRun.getTime() } : {}),
          } as Metadata,
        }
      }

      if (op.action === "loop") {
        const r = yield* scheduler.armLoop({
          prompt: op.prompt,
          delay_seconds: op.delay_seconds,
          reason_length: op.reason?.length ?? 0,
        })
        if (r === null)
          return {
            title: "Loop aged out",
            output: "This loop exceeded max-age — ending.",
            metadata: { aged_out: true } as Metadata,
          }
        return {
          title: `Loop armed: ${r.clampedDelaySeconds}s${r.wasClamped ? " (clamped)" : ""}`,
          output: `Next fire at ${new Date(r.scheduledFor).toLocaleString()}${r.supersededCount ? ` (superseded ${r.supersededCount})` : ""}`,
          metadata: { kind: "loop", scheduled_for: r.scheduledFor } as Metadata,
        }
      }

      if (op.action === "list") {
        const tasks = yield* scheduler.list({
          session_id: sessionID,
          kind: op.kind,
          durable_only: op.durable_only,
        })
        const lines =
          tasks.length === 0
            ? ["No scheduled jobs."]
            : tasks.map((t) => `${t.id} ${t.cron} ${t.kind ?? "cron"} — ${t.prompt.slice(0, 60)}`)
        return {
          title: `Jobs: ${tasks.length}`,
          output: lines.join("\n"),
          metadata: { count: tasks.length, ids: tasks.map((t) => t.id) } as Metadata,
        }
      }

      if (op.action === "get") {
        const t = yield* scheduler.get(op.id, op.session_id ? { session_id: op.session_id } : undefined)
        if (!t)
          return {
            title: `Job ${op.id}: not found`,
            output: `No job ${op.id}. Use \`cron list\` to see ids.`,
            metadata: {} as Metadata,
          }
        return {
          title: `Job ${op.id}`,
          output: JSON.stringify(t, null, 2),
          metadata: { id: t.id, kind: t.kind ?? "cron" } as Metadata,
        }
      }

      if (op.action === "delete") {
        const removed = yield* scheduler.remove(op.id, op.session_id ? { session_id: op.session_id } : undefined)
        return {
          title: removed ? `Cancelled ${op.id}` : `${op.id} not found`,
          output: removed ? `Cancelled ${op.id}` : `No job ${op.id} to cancel.`,
          metadata: { id: op.id } as Metadata,
        }
      }

      // rename
      const renamed = yield* scheduler.rename(
        op.id,
        op.prompt,
        op.session_id ? { session_id: op.session_id } : undefined,
      )
      return {
        title: renamed ? `Renamed ${op.id}` : `${op.id} not found`,
        output: renamed ? `Renamed prompt body` : `No job ${op.id} to rename.`,
        metadata: { id: op.id } as Metadata,
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (args: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) => run(args, ctx).pipe(Effect.orDie),
      shell: {
        description: SHELL_DESCRIPTION,
        parse: parseCronScript,
        recover: recoverCronArgs,
      },
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
