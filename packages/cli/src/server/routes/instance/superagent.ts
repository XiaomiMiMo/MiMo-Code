import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "@/project/instance"
import { Input, SuperagentError, TicketView } from "@/superagent/schema"
import * as Dispatcher from "@/superagent/dispatcher"
import * as Runtime from "@/superagent/runtime"
import * as View from "@/superagent/view"
import * as Channels from "@/superagent/channel"

const description = (id: string, summary: string, schema: z.ZodType = z.unknown()) =>
  describeRoute({
    summary,
    operationId: `superagent.${id}`,
    responses: { 200: { description: summary, content: { "application/json": { schema: resolver(schema) } } } },
  })
const params = validator("param", z.object({ ticketId: z.string().regex(/^ticket_[a-f0-9-]+$/) }))
function key(value?: string) {
  if (!value?.trim() || value.length > 200)
    throw new SuperagentError("Idempotency-Key is required (max 200 characters)", 400)
  return value
}
export function SuperagentRoutes() {
  return new Hono()
    .get(
      "/",
      description("overview", "Read workspace tasks, native Agents, Todo, usage and delivery problems"),
      async (c) => {
        await Runtime.start({ directory: Instance.directory })
        return c.json(await View.snapshot(Instance.directory))
      },
    )
    .post(
      "/master/inputs",
      description(
        "masterInput",
        "Send a natural-language request to the workspace Router",
        z.object({ accepted: z.boolean() }),
      ),
      validator("json", Input),
      async (c) => {
        const eventId = key(c.req.header("Idempotency-Key")),
          body = c.req.valid("json")
        await Runtime.start({ directory: Instance.directory })
        Dispatcher.request(
          Instance.directory,
          {
            channel: "local",
            eventId,
            threadId: `router:${eventId}`,
            senderId: "user",
            attachments: body.attachments,
            model: body.model,
          },
          body.text,
        )
        await Runtime.tick()
        return c.json({ accepted: true })
      },
    )
    .get("/tickets", description("list", "List workspace tasks", z.array(TicketView)), (c) =>
      c.json(Dispatcher.list(Instance.directory)),
    )
    .get("/tickets/:ticketId", description("get", "Read a task and its activity"), params, (c) =>
      c.json(Dispatcher.detail(Instance.directory, c.req.valid("param").ticketId)),
    )
    .post(
      "/tickets/:ticketId/inputs",
      description("input", "Send feedback to the original task Worker", TicketView),
      params,
      validator("json", Input),
      async (c) => {
        const eventId = key(c.req.header("Idempotency-Key")),
          ticketId = c.req.valid("param").ticketId,
          body = c.req.valid("json")
        await Runtime.start({ directory: Instance.directory })
        const t = Dispatcher.follow(
          Instance.directory,
          ticketId,
          {
            channel: "local",
            eventId,
            threadId: ticketId,
            senderId: "user",
            attachments: body.attachments,
            model: body.model,
          },
          body.text,
        )
        await Runtime.tick()
        return c.json(t)
      },
    )
    .post(
      "/tickets/:ticketId/actions",
      description("act", "Stop or resume a task", TicketView),
      params,
      validator("json", z.strictObject({ action: z.enum(["cancel", "resume"]), text: z.string().optional() })),
      async (c) => {
        const body = c.req.valid("json")
        const t = Dispatcher.action(
          Instance.directory,
          c.req.valid("param").ticketId,
          body.action,
          key(c.req.header("Idempotency-Key")),
          body.text,
        )
        await Runtime.start({ directory: Instance.directory })
        await Runtime.tick()
        return c.json(t)
      },
    )
    .post(
      "/deliveries/:actionId/retry",
      description("retryDelivery", "Retry a failed delivery after inspecting the original thread"),
      validator("param", z.object({ actionId: z.string() })),
      (c) => {
        const actionId = c.req.valid("param").actionId
        return c.json({ retried: Dispatcher.retry(Instance.directory, actionId) })
      },
    )
    .get("/channels", description("channels", "Read configured Channel health"), (c) =>
      c.json(Channels.list(Instance.directory)),
    )
}
