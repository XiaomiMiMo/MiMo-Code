import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Effect } from "effect"
import { TaskRegistry } from "@/task/registry"
import type { SessionID } from "../session/schema"

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

type Metadata = {
  id?: string
  status?: string
  ids?: string[]
  count?: number
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
        // ownership: an accidental handoff would leave the original owner with
        // work they no longer track. Intentional handoff stays available to
        // internal callers (actor auto-start in spawn.ts).
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
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
