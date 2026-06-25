import { Hono } from "hono"
import { stream } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import { SessionID, MessageID, PartID } from "@/session/schema"
import z from "zod"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionShare } from "@/share"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { Command } from "@/command"
import { Log } from "@/util"
import { ActorRegistry } from "@/actor/registry"
import { TaskRegistry } from "@/task/registry"
import { Task } from "@/task/schema"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Provider } from "@/provider"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { Bus } from "@/bus"
import { NamedError } from "@mimo-ai/shared/util/error"
import { jsonRequest, runRequest } from "./trace"
import { RateLimitMiddleware } from "../../rate-limit"

const log = Log.create({ service: "server" })

// Cadence of the keep-alive whitespace written on the POST /:sessionID/message
// stream while a turn is in flight. Matches the 10s SSE heartbeat in
// event.ts/global.ts. Read per-request (not memoized) so it can be tuned at
// runtime; smaller values are useful in tests.
function promptHeartbeatIntervalMs() {
  return Number(process.env["MIMOCODE_PROMPT_HEARTBEAT_INTERVAL_MS"]) || 10_000
}

function taskToTodo(t: Task) {
  const status =
    t.status === "in_progress"
      ? "in_progress"
      : t.status === "done"
        ? "completed"
        : t.status === "abandoned"
          ? "cancelled"
          : "pending"
  return { content: t.summary, status }
}

/**
 * Pick the agent identity that should drive a session-level compact:
 * scan the main slice for the most recent user message and use its agent
 * field; fall back to defaultAgent if no main user message exists.
 */
export const resolveCurrentAgent = (sessionID: SessionID, defaultAgent: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const msgs = yield* session.messages({ sessionID, agentID: "main" })
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i].info
      if (info.role === "user") return info.agent || defaultAgent
    }
    return defaultAgent
  })

export const SessionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List sessions",
        description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
        operationId: "session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessions: Session.Info[] = []
        for await (const session of Session.list({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          search: query.search,
          limit: query.limit,
        })) {
          sessions.push(session)
        }
        return c.json(sessions)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get session status",
        description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
        operationId: "session.status",
        responses: {
          200: {
            description: "Get session status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), SessionStatus.Info)),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) =>
        jsonRequest("SessionRoutes.status", c, function* () {
          const svc = yield* SessionStatus.Service
          return Object.fromEntries(yield* svc.list())
        }),
    )
    .get(
      "/:sessionID",
      describeRoute({
        summary: "Get session",
        description: "Retrieve detailed information about a specific OpenCode session.",
        tags: ["Session"],
        operationId: "session.get",
        responses: {
          200: {
            description: "Get session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.GetInput,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        return jsonRequest("SessionRoutes.get", c, function* () {
          const session = yield* Session.Service
          return yield* session.get(sessionID)
        })
      },
    )
    .get(
      "/:sessionID/children",
      describeRoute({
        summary: "Get session children",
        tags: ["Session"],
        description: "Retrieve all child sessions that were forked from the specified parent session.",
        operationId: "session.children",
        responses: {
          200: {
            description: "List of children",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.ChildrenInput,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        return jsonRequest("SessionRoutes.children", c, function* () {
          const session = yield* Session.Service
          return yield* session.children(sessionID)
        })
      },
    )
    .get(
      "/:sessionID/todo",
      describeRoute({
        summary: "Get session todos",
        description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
        operationId: "session.todo",
        responses: {
          200: {
            description: "Todo list",
            content: {
              "application/json": {
                schema: resolver(Todo.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        return jsonRequest("SessionRoutes.todo", c, function* () {
          const reg = yield* TaskRegistry.Service
          const tasks = yield* reg.list({ session_id: sessionID, include_terminal: true })
          if (tasks.length > 0) return tasks.map(taskToTodo)
          const todo = yield* Todo.Service
          return yield* todo.get(sessionID)
        })
      },
    )
    .get(
      "/:sessionID/task",
      describeRoute({
        summary: "List session tasks",
        description: "List tasks registered for a session (the work-item registry).",
        operationId: "session.task",
        responses: {
          200: {
            description: "Task list",
            content: {
              "application/json": {
                schema: resolver(Task.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const tasks = await runRequest(
          "SessionRoutes.task",
          c,
          Effect.gen(function* () {
            const reg = yield* TaskRegistry.Service
            const session = yield* Session.Service
            yield* session.get(sessionID)
            return yield* reg.list({ session_id: sessionID, include_terminal: true })
          }),
        )
        return c.json(tasks)
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create session",
        description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
        operationId: "session.create",
        responses: {
          ...errors(400),
          200: {
            description: "Successfully created session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator("json", Session.CreateInput),
      async (c) =>
        jsonRequest("SessionRoutes.create", c, function* () {
          const body = c.req.valid("json") ?? {}
          const svc = yield* SessionShare.Service
          return yield* svc.create(body)
        }),
    )
    .delete(
      "/:sessionID",
      describeRoute({
        summary: "Delete session",
        description: "Delete a session and permanently remove all associated data, including messages and history.",
        operationId: "session.delete",
        responses: {
          200: {
            description: "Successfully deleted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.RemoveInput,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.delete", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const svc = yield* Session.Service
          yield* svc.remove(sessionID)
          return true
        }),
    )
    .patch(
      "/:sessionID",
      describeRoute({
        summary: "Update session",
        description: "Update properties of an existing session, such as title or other metadata.",
        operationId: "session.update",
        responses: {
          200: {
            description: "Successfully updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          permission: Permission.Ruleset.zod.optional(),
          time: z
            .object({
              archived: z.number().optional(),
            })
            .optional(),
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.update", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const updates = c.req.valid("json")
          const session = yield* Session.Service
          const current = yield* session.get(sessionID)

          if (updates.title !== undefined) {
            yield* session.setTitle({ sessionID, title: updates.title })
          }
          if (updates.permission !== undefined) {
            yield* session.setPermission({
              sessionID,
              permission: Permission.merge(current.permission ?? [], updates.permission),
            })
          }
          if (updates.time?.archived !== undefined) {
            yield* session.setArchived({ sessionID, time: updates.time.archived })
          }

          return yield* session.get(sessionID)
        }),
    )
    // TODO(v2): remove this dedicated route and rely on the normal `/init` command flow.
    .post(
      "/:sessionID/init",
      describeRoute({
        summary: "Initialize session",
        description:
          "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
        operationId: "session.init",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.init", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const svc = yield* SessionPrompt.Service
          yield* svc.command({
            sessionID,
            messageID: body.messageID,
            model: body.providerID + "/" + body.modelID,
            command: Command.Default.INIT,
            arguments: "",
          })
          return true
        }),
    )
    .post(
      "/:sessionID/fork",
      describeRoute({
        summary: "Fork session",
        description: "Create a new session by forking an existing session at a specific message point.",
        operationId: "session.fork",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.ForkInput.shape.sessionID,
        }),
      ),
      validator("json", Session.ForkInput.omit({ sessionID: true })),
      async (c) =>
        jsonRequest("SessionRoutes.fork", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const svc = yield* Session.Service
          return yield* svc.fork({ ...body, sessionID })
        }),
    )
    .post(
      "/:sessionID/abort",
      describeRoute({
        summary: "Abort session",
        description: "Abort an active session and stop any ongoing AI processing or command execution.",
        operationId: "session.abort",
        responses: {
          200: {
            description: "Aborted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.abort", c, function* () {
          const svc = yield* SessionPrompt.Service
          yield* svc.cancel(c.req.valid("param").sessionID)
          return true
        }),
    )
    .post(
      "/:sessionID/share",
      describeRoute({
        summary: "Share session",
        description: "Create a shareable link for a session, allowing others to view the conversation.",
        operationId: "session.share",
        responses: {
          200: {
            description: "Successfully shared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.share", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const share = yield* SessionShare.Service
          const session = yield* Session.Service
          yield* share.share(sessionID)
          return yield* session.get(sessionID)
        }),
    )
    .get(
      "/:sessionID/diff",
      describeRoute({
        summary: "Get message diff",
        description: "Get the file changes (diff) that resulted from a specific user message in the session.",
        operationId: "session.diff",
        responses: {
          200: {
            description: "Successfully retrieved diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionSummary.DiffInput.shape.sessionID,
        }),
      ),
      validator(
        "query",
        z.object({
          messageID: SessionSummary.DiffInput.shape.messageID,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.diff", c, function* () {
          const query = c.req.valid("query")
          const params = c.req.valid("param")
          const summary = yield* SessionSummary.Service
          return yield* summary.diff({
            sessionID: params.sessionID,
            messageID: query.messageID,
          })
        }),
    )
    .delete(
      "/:sessionID/share",
      describeRoute({
        summary: "Unshare session",
        description: "Remove the shareable link for a session, making it private again.",
        operationId: "session.unshare",
        responses: {
          200: {
            description: "Successfully unshared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.unshare", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const share = yield* SessionShare.Service
          const session = yield* Session.Service
          yield* share.unshare(sessionID)
          return yield* session.get(sessionID)
        }),
    )
    .post(
      "/:sessionID/summarize",
      describeRoute({
        summary: "Summarize session",
        description: "Generate a concise summary of the session using AI compaction to preserve key information.",
        operationId: "session.summarize",
        responses: {
          200: {
            description: "Summarized session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          providerID: ProviderID.zod,
          modelID: ModelID.zod,
          auto: z.boolean().optional().default(false),
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.summarize", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const compact = yield* SessionCompaction.Service
          const prompt = yield* SessionPrompt.Service
          const agent = yield* Agent.Service

          yield* revert.cleanup(yield* session.get(sessionID))
          const currentAgent = yield* resolveCurrentAgent(sessionID, yield* agent.defaultAgent())

          yield* compact.create({
            sessionID,
            agent: currentAgent,
            model: {
              providerID: body.providerID,
              modelID: body.modelID,
            },
            auto: body.auto,
            agentID: "main",
          })
          yield* prompt.loop({ sessionID })
          return true
        }),
    )
    .get(
      "/:sessionID/message",
      describeRoute({
        summary: "Get session messages",
        description: "Retrieve all messages in a session, including user prompts and AI responses.",
        operationId: "session.messages",
        responses: {
          200: {
            description: "List of messages",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "query",
        z
          .object({
            limit: z.coerce
              .number()
              .int()
              .min(0)
              .max(1000)
              .optional()
              .meta({ description: "Maximum number of messages to return (max 1000)" }),
            before: z
              .string()
              .optional()
              .meta({ description: "Opaque cursor for loading older messages" })
              .refine(
                (value) => {
                  if (!value) return true
                  try {
                    MessageV2.cursor.decode(value)
                    return true
                  } catch {
                    return false
                  }
                },
                { message: "Invalid cursor" },
              ),
            agent_id: z
              .string()
              .optional()
              .meta({
                description:
                  "Filter by message slice. Omitted = main-agent slice only (default). Pass a subagent's actor id to fetch its slice. Pass `*` to return every message regardless of slice.",
              }),
          })
          .refine((value) => !value.before || value.limit !== undefined, {
            message: "before requires limit",
            path: ["before"],
          }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessionID = c.req.valid("param").sessionID
        // Default to main-agent slice when omitted; `"*"` and explicit
        // actorIDs forward verbatim to Session.messages, which now owns the
        // slice contract.
        const agentID = query.agent_id ?? "main"

        if (query.limit === undefined || query.limit === 0) {
          const messages = await runRequest(
            "SessionRoutes.messages",
            c,
            Effect.gen(function* () {
              const session = yield* Session.Service
              yield* session.get(sessionID)
              return yield* session.messages({ sessionID, agentID, limit: 1000 })
            }),
          )
          return c.json(messages)
        }

        const page = await MessageV2.page({
          sessionID,
          limit: query.limit,
          before: query.before,
          agentID,
        })
        if (page.cursor) {
          const url = new URL(c.req.url)
          url.searchParams.set("limit", query.limit.toString())
          url.searchParams.set("before", page.cursor)
          c.header("Access-Control-Expose-Headers", "Link, X-Next-Cursor")
          c.header("Link", `<${url.toString()}>; rel="next"`)
          c.header("X-Next-Cursor", page.cursor)
        }
        return c.json(page.items)
      },
    )
    .get(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Get message",
        description: "Retrieve a specific message from a session by its message ID.",
        operationId: "session.message",
        responses: {
          200: {
            description: "Message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Info,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const message = await MessageV2.get({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(message)
      },
    )
    .delete(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Delete message",
        description:
          "Permanently delete a specific message (and all of its parts) from a session. This does not revert any file changes that may have been made while processing the message.",
        operationId: "session.deleteMessage",
        responses: {
          200: {
            description: "Successfully deleted message",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.deleteMessage", c, function* () {
          const params = c.req.valid("param")
          const state = yield* SessionRunState.Service
          const session = yield* Session.Service
          yield* state.assertNotBusy(params.sessionID)
          yield* session.removeMessage({
            sessionID: params.sessionID,
            messageID: params.messageID,
          })
          return true
        }),
    )
    .delete(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Delete a part from a message",
        operationId: "part.delete",
        responses: {
          200: {
            description: "Successfully deleted part",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.deletePart", c, function* () {
          const params = c.req.valid("param")
          const svc = yield* Session.Service
          yield* svc.removePart({
            sessionID: params.sessionID,
            messageID: params.messageID,
            partID: params.partID,
          })
          return true
        }),
    )
    .patch(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Update a part in a message",
        operationId: "part.update",
        responses: {
          200: {
            description: "Successfully updated part",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Part),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      validator("json", MessageV2.Part),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        if (body.id !== params.partID || body.messageID !== params.messageID || body.sessionID !== params.sessionID) {
          throw new Error(
            `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
          )
        }
        return jsonRequest("SessionRoutes.updatePart", c, function* () {
          const svc = yield* Session.Service
          return yield* svc.updatePart(body)
        })
      },
    )
    .post(
      "/:sessionID/message",
      describeRoute({
        summary: "Send message",
        description: "Create and send a new message to a session, streaming the AI response.",
        operationId: "session.prompt",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID

        // Pre-check: bail with 409 Conflict if the session's main runner is busy
        // with another request. Without this guard, ensureRunning silently queues
        // the new work behind the existing runner (which may be a zombie from a
        // SIGKILL'd previous client), causing the new client to hang for the
        // duration of the old runner's retry envelope. Caller's recovery path:
        // POST /:sessionID/abort to free the runner, then retry this POST.
        await runRequest(
          "SessionRoutes.prompt.assertNotBusy",
          c,
          SessionRunState.Service.use((svc) => svc.assertNotBusy(sessionID)),
        )

        c.status(200)
        c.header("Content-Type", "application/json")
        return stream(c, async (stream) => {
          const body = c.req.valid("json")
          // If the HTTP client gives up (TUI exits, driver kills its `mimo run`
          // client on its own per-turn timeout, network drop), we have to drive
          // the server-side runner to Idle ourselves. Otherwise the prompt
          // fiber keeps running with no consumer, and any next POST attaches
          // to the same dead Deferred via SessionRunState.ensureRunning's
          // `Running` branch — every subsequent turn then hangs waiting on a
          // result that will never arrive. SessionPrompt.cancel interrupts
          // the fiber, which lets the runner transition Running -> Idle
          // through Runner.cancel, freeing the next POST to start a fresh run.
          const signal = c.req.raw.signal
          const onClientDisconnect = () => {
            void runRequest(
              "SessionRoutes.prompt.disconnect",
              c,
              SessionPrompt.Service.use((svc) => svc.cancel(sessionID)),
            ).catch(() => {})
          }
          if (signal.aborted) {
            onClientDisconnect()
            return
          }
          signal.addEventListener("abort", onClientDisconnect, { once: true })
          // Keep the response alive while the turn is in flight. A turn can sit
          // silent for a long time — most notably while the `question` tool
          // blocks on an un-timed Deferred waiting for a human reply (the Bun
          // server itself never times out: adapter.bun.ts idleTimeout:0). A
          // client with its own request timeout (e.g. the external `mimo run`
          // driver's per-turn budget) would otherwise see a dead connection and
          // abort with "error sending request for url". Periodic whitespace
          // resets the client's idle timer; whitespace is JSON-insignificant,
          // so the trailing JSON.stringify(msg) still parses as the whole body
          // (clients JSON.parse the full body, which tolerates leading
          // whitespace). Mirrors the 10s SSE heartbeat in event.ts/global.ts.
          const heartbeat = setInterval(() => {
            void stream.write(" ")
          }, promptHeartbeatIntervalMs())
          try {
            const msg = await runRequest(
              "SessionRoutes.prompt",
              c,
              SessionPrompt.Service.use((svc) => svc.prompt({ ...body, sessionID })),
            )
            // Safety invariant: no await/yield between this write and the
            // clearInterval below (reached synchronously via finally) — else the
            // interval could fire and append a stray space AFTER the JSON,
            // breaking the "JSON is the whole body" contract. Leading spaces are
            // JSON-insignificant; a trailing one would not be.
            void stream.write(JSON.stringify(msg))
          } finally {
            clearInterval(heartbeat)
            signal.removeEventListener("abort", onClientDisconnect)
          }
        })
      },
    )
    .post(
      "/:sessionID/prompt_async",
      RateLimitMiddleware({ windowMs: 60_000, max: 20, keyPrefix: "prompt_async" }),
      describeRoute({
        summary: "Send async message",
        description:
          "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
        operationId: "session.prompt_async",
        responses: {
          204: {
            description: "Prompt accepted",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        void runRequest(
          "SessionRoutes.prompt_async",
          c,
          SessionPrompt.Service.use((svc) => svc.prompt({ ...body, sessionID })),
        ).catch((err) => {
          log.error("prompt_async failed", { sessionID, error: err })
          void Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({ message: err instanceof Error ? err.message : String(err) }).toObject(),
          })
        })

        return c.body(null, 204)
      },
    )
    .post(
      "/:sessionID/command",
      describeRoute({
        summary: "Send command",
        description: "Send a new command to a session for execution by the AI assistant.",
        operationId: "session.command",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.CommandInput.omit({ sessionID: true })),
      async (c) =>
        jsonRequest("SessionRoutes.command", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const svc = yield* SessionPrompt.Service
          return yield* svc.command({ ...body, sessionID })
        }),
    )
    .post(
      "/:sessionID/predict",
      describeRoute({
        summary: "Predict next prompt",
        description:
          "Predict the user's most likely next prompt based on the latest user message and the assistant's result. Returns an empty string when disabled or unavailable.",
        operationId: "session.predict",
        responses: {
          200: {
            description: "Predicted next prompt",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    prediction: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.predict", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const svc = yield* SessionPrompt.Service
          const prediction = yield* svc.predict({ sessionID })
          return { prediction }
        }),
    )
    .post(
      "/:sessionID/shell",
      RateLimitMiddleware({ windowMs: 60_000, max: 20, keyPrefix: "shell" }),
      describeRoute({
        summary: "Run shell command",
        description: "Execute a shell command within the session context and return the AI's response.",
        operationId: "session.shell",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.ShellInput.omit({ sessionID: true })),
      async (c) =>
        jsonRequest("SessionRoutes.shell", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const svc = yield* SessionPrompt.Service
          return yield* svc.shell({ ...body, sessionID })
        }),
    )
    .post(
      "/:sessionID/revert",
      describeRoute({
        summary: "Revert message",
        description: "Revert a specific message in a session, undoing its effects and restoring the previous state.",
        operationId: "session.revert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionRevert.RevertInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("revert", c.req.valid("json"))
        return jsonRequest("SessionRoutes.revert", c, function* () {
          const svc = yield* SessionRevert.Service
          return yield* svc.revert({
            sessionID,
            ...c.req.valid("json"),
          })
        })
      },
    )
    .post(
      "/:sessionID/unrevert",
      describeRoute({
        summary: "Restore reverted messages",
        description: "Restore all previously reverted messages in a session.",
        operationId: "session.unrevert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.unrevert", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const svc = yield* SessionRevert.Service
          return yield* svc.unrevert({ sessionID })
        }),
    )
    .post(
      "/:sessionID/permissions/:permissionID",
      describeRoute({
        summary: "Respond to permission",
        deprecated: true,
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.respond",
        responses: {
          200: {
            description: "Permission processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          permissionID: PermissionID.zod,
        }),
      ),
      validator("json", z.object({ response: Permission.Reply.zod })),
      async (c) =>
        jsonRequest("SessionRoutes.permissionRespond", c, function* () {
          const params = c.req.valid("param")
          const svc = yield* Permission.Service
          yield* svc.reply({
            requestID: params.permissionID,
            reply: c.req.valid("json").response,
          })
          return true
        }),
    )
    .get(
      "/:sessionID/actors",
      describeRoute({
        summary: "List session actors",
        description: "List actors registered for a session.",
        operationId: "session.actors",
        responses: {
          200: {
            description: "Actor list",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const actors = await runRequest(
          "SessionRoutes.actors",
          c,
          Effect.gen(function* () {
            const reg = yield* ActorRegistry.Service
            const session = yield* Session.Service
            yield* session.get(sessionID)
            return yield* reg.listBySession(sessionID)
          }),
        )
        return c.json(actors)
      },
    ),
)
