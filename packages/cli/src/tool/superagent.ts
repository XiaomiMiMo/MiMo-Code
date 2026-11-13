import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { RecoverableError } from "./recoverable"
import { Database, eq, inArray } from "@/storage"
import { SessionID } from "@/session/schema"
import { PartTable } from "@/session/session.sql"
import { MessageV2 } from "@/session/message-v2"
import { StateTable } from "@/superagent/superagent.sql"
import * as Dispatcher from "@/superagent/dispatcher"
import * as Channels from "@/superagent/channel"
import { binding } from "@/superagent/execution"
import { Report, SuperagentError } from "@/superagent/schema"
import { TaskTable } from "@/task/task.sql"
import { ActorRegistryTable } from "@/actor/actor.sql"

function define<S extends z.ZodType>(
  id: string,
  description: string,
  parameters: S,
  fn: (args: z.infer<S>, ctx: Tool.Context) => unknown | Promise<unknown>,
  terminal?: (args: z.infer<S>) => boolean,
) {
  return Tool.define<S, Record<string, unknown>, never>(
    id,
    Effect.succeed({
      description,
      parameters,
      execute: (args: z.infer<S>, ctx: Tool.Context) =>
        Effect.tryPromise({
          try: async () => {
            const result = await fn(args, ctx)
            return {
              title: id,
              metadata: terminal?.(args) ? { superagentTerminal: true } : {},
              output: typeof result === "string" ? result : JSON.stringify(result ?? null),
            }
          },
          catch: (error) => new RecoverableError(error instanceof Error ? error.message : String(error)),
        }).pipe(Effect.orDie),
    }),
  )
}
function workspace(ctx: Tool.Context) {
  const row = Database.use((db) =>
    db.select().from(StateTable).where(eq(StateTable.router_session_id, ctx.sessionID)).get(),
  )
  if (ctx.agent !== "superagent-router" || !row?.id.startsWith("router:"))
    throw new SuperagentError("Only this workspace Router can route", 403)
  return row.id.slice("router:".length)
}
export const SuperagentReadTool = define(
  "superagent_read",
  "Read this workspace's tasks, one task with its activity, or an original input.",
  z.strictObject({
    action: z.enum(["list", "ticket", "input"]),
    ticketId: z.string().optional(),
    inputId: z.string().optional(),
  }),
  (args, ctx) => {
    const directory = workspace(ctx)
    if (args.action === "list") return Dispatcher.list(directory)
    if (args.action === "ticket" && args.ticketId) return Dispatcher.detail(directory, args.ticketId)
    if (args.action === "input" && args.inputId) return Dispatcher.input(directory, args.inputId)
    throw new SuperagentError("Supply the ID required by this read action", 400)
  },
)
export const SuperagentRouteTool = define(
  "superagent_route",
  "Create a task from its original input, attach an explicit reference to an existing task, or clarify/ignore a message. Detailed goals and checks belong to the Worker.",
  z.strictObject({
    inputId: z.string(),
    action: z.enum(["create", "attach", "clarify", "ignore"]),
    goal: z.string().trim().min(1).max(8000).optional(),
    criteria: z.array(z.string()).max(30).optional(),
    ticketId: z.string().optional(),
    text: z.string().trim().min(1).optional(),
  }),
  (args, ctx) => {
    const directory = workspace(ctx)
    Dispatcher.input(directory, args.inputId)
    if (args.action === "create" && args.goal) {
      const t = Dispatcher.create(directory, args.inputId, args.goal, args.criteria)
      return { ticketId: t.id, goal: t.goal, phase: t.phase }
    }
    if (args.action === "attach" && args.ticketId) {
      const t = Dispatcher.attach(directory, args.ticketId, args.inputId)
      return { ticketId: t.id, phase: t.phase }
    }
    if (args.action === "clarify" && args.text) {
      Dispatcher.reply(directory, args.inputId, args.text)
      return { accepted: true }
    }
    if (args.action === "ignore") {
      Dispatcher.resolved(directory, args.inputId)
      return { accepted: true }
    }
    throw new SuperagentError("Missing fields for this routing action", 400)
  },
)
export const SuperagentReplyTool = define(
  "superagent_reply",
  "Reply to the original input's Channel. Keep work in its task; do not send routine progress.",
  z.strictObject({ inputId: z.string(), text: z.string().trim().min(1).max(8000) }),
  (args, ctx) => {
    const directory = workspace(ctx)
    Dispatcher.reply(directory, args.inputId, args.text)
    Dispatcher.resolved(directory, args.inputId)
    return { accepted: true }
  },
)
export const SuperagentReportTool = define(
  "superagent_report",
  "Report progress, a ready delivery, waiting or a concrete blocker. The native request binds task identity. Put a question in humanAction; null clears it. Include real artifact URLs/paths and observed checks.",
  Report,
  (args, ctx) => {
    const { t, revision } = binding(ctx)
    if (args.state === "ready") {
      const parts = Database.use((db) =>
        db.select().from(PartTable).where(eq(PartTable.message_id, ctx.messageID)).all(),
      )
      for (const part of parts) {
        const value = MessageV2.Part.parse({
          ...part.data,
          id: part.id,
          messageID: part.message_id,
          sessionID: part.session_id,
        })
        if (
          value.type === "tool" &&
          value.callID !== ctx.callID &&
          (value.state.status === "pending" || value.state.status === "running")
        )
          throw new SuperagentError("Wait for the other tools in this batch before delivery")
      }
      const tasks = Database.use((db) =>
        db.select().from(TaskTable).where(eq(TaskTable.session_id, ctx.sessionID)).all(),
      )
      if (tasks.some((t) => t.status !== "done" && t.status !== "abandoned"))
        throw new SuperagentError("Finish or explicitly abandon published Todo before delivery")
      const ids = Dispatcher.sessionIds(t).map((id) => SessionID.make(id))
      const children = Database.use((db) =>
        db.select().from(ActorRegistryTable).where(inArray(ActorRegistryTable.session_id, ids)).all(),
      )
      if (
        children.some(
          (a) =>
            a.status !== "idle" &&
            !(a.session_id === ctx.sessionID && a.actor_id === (ctx.actorID ?? "main")) &&
            a.mode !== "main",
        )
      )
        throw new SuperagentError("Collect required helpers before delivery")
    }
    Dispatcher.report(t, revision, args)
    return [args.summary, args.humanAction, ...(args.artifacts ?? [])].filter(Boolean).join("\n")
  },
  (args) => args.state !== "progress" || !!args.humanAction,
)
export const SuperagentThreadsTool = define(
  "superagent_threads",
  "Subscribe this task to a delivered PR or related thread, or return an unrelated input to the Router with its reason.",
  z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("subscribe"), channel: z.string(), reference: z.string() }),
    z.strictObject({ action: z.literal("handback"), inputId: z.string(), reason: z.string().trim().min(1) }),
  ]),
  async (args, ctx) => {
    const { t } = binding(ctx)
    if (args.action === "subscribe") return Channels.subscribe(t.directory, t.id, args.channel, args.reference)
    Dispatcher.handback(t.directory, t.id, args.inputId, args.reason)
    return { accepted: true }
  },
)
