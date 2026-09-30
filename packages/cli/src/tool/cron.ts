import * as Tool from "./tool"
import DESCRIPTION from "./cron.txt"
import z from "zod"
import { Effect } from "effect"
import { Scheduler } from "@/cron/scheduler"
import { computeNextCronRun } from "@/cron/cron-expr"
import type { SessionID } from "../session/schema"

const id = "cron"

const sessionFlag = z.string().min(1).optional().describe("Session id to act on. Defaults to current session.")
const kindSchema = z.enum(["cron", "loop"])

const scheduleOperation = z.strictObject({
  action: z.literal("schedule"),
  cron: z.string().min(1).describe("5-field cron expression (minute hour dom month dow), evaluated in UTC."),
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
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
