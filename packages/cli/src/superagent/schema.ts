import z from "zod"

export const routerStateId = (directory: string) => `router:${directory}`
export const Attachments = z
  .array(z.object({ url: z.string(), mime: z.string(), filename: z.string().optional() }))
  .max(20)
export const Model = z.object({ providerID: z.string(), modelID: z.string(), variant: z.string().optional() })
export const Source = z.object({
  channel: z.string(),
  eventId: z.string(),
  threadId: z.string(),
  senderId: z.string(),
  attachments: Attachments.optional(),
  model: Model.optional(),
  threadKind: z.enum(["discussion", "deliverable"]).optional(),
  url: z.string().optional(),
})
export type Source = z.infer<typeof Source>
export const Phase = z.enum(["queued", "working", "waiting", "awaiting_review", "blocked", "completed", "cancelled"])
export const Create = z.strictObject({
  goal: z.string().trim().min(1).max(8000),
  criteria: z.array(z.string().trim().min(1).max(2000)).max(30).default([]),
})
export const Input = z.strictObject({
  text: z.string().trim().min(1).max(32000),
  attachments: Attachments.optional(),
  model: Model.optional(),
})
export const Report = z.strictObject({
  state: z.enum(["progress", "waiting", "ready", "blocked", "failed", "dropped"]),
  summary: z.string().trim().min(1).max(8000),
  humanAction: z.string().trim().min(1).max(2000).nullish(),
  artifacts: z.array(z.string().trim().min(1)).max(30).optional(),
  replyTo: z.string().optional(),
})
export const TicketView = Create.extend({
  id: z.string(),
  version: z.number(),
  directory: z.string(),
  phase: Phase,
  revision: z.number(),
  workerSessionId: z.string().optional(),
  workerActorId: z.string().optional(),
  worktree: z.string().optional(),
  baseCommit: z.string().optional(),
  summary: z.string(),
  attention: z.string().optional(),
  artifacts: z.array(z.string()),
  source: Source,
  subscriptions: z.array(
    z.object({
      channel: z.string(),
      threadId: z.string(),
      kind: z.enum(["origin", "context", "deliverable"]),
      url: z.string().optional(),
      closed: z.enum(["merged", "closed"]).optional(),
    }),
  ),
  handbacks: z.array(z.string()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Ticket = z.infer<typeof TicketView>
export type StoredInput = { source: Source; kind: "request" | "feedback" | "status" }
export type ActionKind = "route" | "deliver" | "reply" | "stop"
export type ActionPayload = {
  version?: 2
  inputId?: string
  revision?: number
  text?: string
  source?: Source
  messageId?: string
}
export class SuperagentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 409,
  ) {
    super(message)
    this.name = "SuperagentError"
  }
}
