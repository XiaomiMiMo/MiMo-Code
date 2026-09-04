import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { ProviderID, ModelID } from "@/provider/schema"
import { ToolRegistry } from "@/tool"
import { Worktree } from "@/worktree"
import { checkConflict, type ConflictResult } from "@/tool/conflict-detection"
import { Instance } from "@/project/instance"
import { Project } from "@/project"
import { MCP } from "@/mcp"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Config } from "@/config"
import { ConsoleState } from "@/config/console-state"
import { Account } from "@/account/account"
import { AccountID, OrgID } from "@/account/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { Effect, Option } from "effect"
import { Agent } from "@/agent/agent"
import { jsonRequest, runRequest } from "./trace"

const ConsoleOrgOption = z.object({
  accountID: z.string(),
  accountEmail: z.string(),
  accountUrl: z.string(),
  orgID: z.string(),
  orgName: z.string(),
  active: z.boolean(),
})

const ConsoleOrgList = z.object({
  orgs: z.array(ConsoleOrgOption),
})

const ConsoleSwitchBody = z.object({
  accountID: z.string(),
  orgID: z.string(),
})

const GenTitlePart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(20_000) }),
  z.object({
    type: z.literal("image"),
    data: z.string().min(4).regex(/^[A-Za-z0-9+/]+={0,2}$/).max(5_600_000),
    mime: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
    filename: z.string().max(512).optional(),
  }),
])
const GenTitleBody = z
  .object({
    text: z.string().max(20_000).optional(),
    parts: z.array(GenTitlePart).min(1).max(8).optional(),
    locale: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const meaningful = Boolean(value.text?.trim()) || value.parts?.some((part) => part.type === "image" || part.text.trim())
    if (!meaningful) ctx.addIssue({ code: "custom", message: "text or a non-empty part is required" })
    const imageBytes = (value.parts ?? []).reduce((total, part) => {
      if (part.type !== "image") return total
      const padding = part.data.endsWith("==") ? 2 : part.data.endsWith("=") ? 1 : 0
      return total + Math.floor((part.data.length * 3) / 4) - padding
    }, 0)
    if (imageBytes > 8 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "images exceed the 8 MiB total limit" })
  })
const GenTitleResult = z.object({ title: z.string(), status: z.enum(["generated", "fallback", "untitled"]) })
const GenTitleRequestBody = {
  required: true,
  content: { "application/json": { schema: z.toJSONSchema(GenTitleBody) } },
} as unknown as NonNullable<Parameters<typeof describeRoute>[0]["requestBody"]>
export const ExperimentalRoutes = lazy(() =>
  new Hono()
    .get(
      "/console",
      describeRoute({
        summary: "Get active Console provider metadata",
        description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
        operationId: "experimental.console.get",
        responses: {
          200: {
            description: "Active Console provider metadata",
            content: {
              "application/json": {
                schema: resolver(ConsoleState.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.console.get", c, function* () {
          const config = yield* Config.Service
          const account = yield* Account.Service
          const [state, groups] = yield* Effect.all([config.getConsoleState(), account.orgsByAccount()], {
            concurrency: "unbounded",
          })
          return {
            ...state,
            switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
          }
        }),
    )
    .get(
      "/console/orgs",
      describeRoute({
        summary: "List switchable Console orgs",
        description: "Get the available Console orgs across logged-in accounts, including the current active org.",
        operationId: "experimental.console.listOrgs",
        responses: {
          200: {
            description: "Switchable Console orgs",
            content: {
              "application/json": {
                schema: resolver(ConsoleOrgList),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.console.listOrgs", c, function* () {
          const account = yield* Account.Service
          const [groups, active] = yield* Effect.all([account.orgsByAccount(), account.active()], {
            concurrency: "unbounded",
          })
          const info = Option.getOrUndefined(active)
          const orgs = groups.flatMap((group) =>
            group.orgs.map((org) => ({
              accountID: group.account.id,
              accountEmail: group.account.email,
              accountUrl: group.account.url,
              orgID: org.id,
              orgName: org.name,
              active: !!info && info.id === group.account.id && info.active_org_id === org.id,
            })),
          )
          return { orgs }
        }),
    )
    .post(
      "/console/switch",
      describeRoute({
        summary: "Switch active Console org",
        description: "Persist a new active Console account/org selection for the current local OpenCode state.",
        operationId: "experimental.console.switchOrg",
        responses: {
          200: {
            description: "Switch success",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("json", ConsoleSwitchBody),
      async (c) =>
        jsonRequest("ExperimentalRoutes.console.switchOrg", c, function* () {
          const body = c.req.valid("json")
          const account = yield* Account.Service
          yield* account.use(AccountID.make(body.accountID), Option.some(OrgID.make(body.orgID)))
          return true
        }),
    )
    .get(
      "/tool/ids",
      describeRoute({
        summary: "List tool IDs",
        description:
          "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
        operationId: "tool.ids",
        responses: {
          200: {
            description: "Tool IDs",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string()).meta({ ref: "ToolIDs" })),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.tool.ids", c, function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.ids()
        }),
    )
    .get(
      "/tool",
      describeRoute({
        summary: "List tools",
        description:
          "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
        operationId: "tool.list",
        responses: {
          200: {
            description: "Tools",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .array(
                      z
                        .object({
                          id: z.string(),
                          description: z.string(),
                          parameters: z.any(),
                        })
                        .meta({ ref: "ToolListItem" }),
                    )
                    .meta({ ref: "ToolList" }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          provider: z.string(),
          model: z.string(),
        }),
      ),
      async (c) => {
        const { provider, model } = c.req.valid("query")
        const tools = await runRequest(
          "ExperimentalRoutes.tool.list",
          c,
          Effect.gen(function* () {
            const agents = yield* Agent.Service
            const registry = yield* ToolRegistry.Service
            return yield* registry.tools({
              providerID: ProviderID.make(provider),
              modelID: ModelID.make(model),
              agent: yield* agents.get(yield* agents.defaultAgent()),
            })
          }),
        )
        return c.json(
          tools.map((t) => ({
            id: t.id,
            description: t.description,
            parameters: z.toJSONSchema(t.parameters),
          })),
        )
      },
    )
    .post(
      "/worktree",
      describeRoute({
        summary: "Create worktree",
        description: "Create a new git worktree for the current project and run any configured startup scripts.",
        operationId: "worktree.create",
        responses: {
          200: {
            description: "Worktree created",
            content: {
              "application/json": {
                schema: resolver(Worktree.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.CreateInput.optional()),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.create", c, function* () {
          const body = c.req.valid("json")
          const svc = yield* Worktree.Service
          return yield* svc.create(body)
        }),
    )
    .get(
      "/worktree",
      describeRoute({
        summary: "List worktrees",
        description: "List all sandbox worktrees for the current project.",
        operationId: "worktree.list",
        responses: {
          200: {
            description: "List of worktree directories",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string())),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.list", c, function* () {
          const svc = yield* Project.Service
          return yield* svc.sandboxes(Instance.project.id)
        }),
    )
    .delete(
      "/worktree",
      describeRoute({
        summary: "Remove worktree",
        description: "Remove a git worktree and delete its branch.",
        operationId: "worktree.remove",
        responses: {
          200: {
            description: "Worktree removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.RemoveInput),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.remove", c, function* () {
          const body = c.req.valid("json")
          const worktree = yield* Worktree.Service
          const project = yield* Project.Service
          yield* worktree.remove(body)
          yield* project.removeSandbox(Instance.project.id, body.directory)
          return true
        }),
    )
    .post(
      "/worktree/reset",
      describeRoute({
        summary: "Reset worktree",
        description: "Reset a worktree branch to the primary default branch.",
        operationId: "worktree.reset",
        responses: {
          200: {
            description: "Worktree reset",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.ResetInput),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.reset", c, function* () {
          const body = c.req.valid("json")
          const svc = yield* Worktree.Service
          yield* svc.reset(body)
          return true
        }),
    )
    .post(
      "/worktree/auto",
      describeRoute({
        summary: "Auto-create worktree on conflict",
        description: "Check for conflicts and auto-create a worktree if needed.",
        operationId: "worktree.auto",
        responses: {
          200: { description: "Worktree info or null", content: { "application/json": { schema: resolver(z.union([Worktree.Info, z.null()])) } } },
          ...errors(400),
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.auto", c, function* () {
          const body = yield* Effect.promise(() => c.req.json().catch(() => ({})))
          const sessionID = typeof body?.sessionID === "string" ? body.sessionID : undefined
          const conflict = (yield* Effect.promise(() => checkConflict(Instance.directory, sessionID))) as ConflictResult
          if (!conflict.hasConflict) return null
          return yield* (yield* Worktree.Service).create()
        }),
    )
    .post("/title", describeRoute({
      summary: "Generate conversation title",
      description: "Generate a short conversation title with the configured lite model and deterministic fallback.",
      operationId: "experimental.title.generate",
      requestBody: GenTitleRequestBody,
      responses: { 200: { description: "Generated conversation title", content: { "application/json": { schema: resolver(GenTitleResult) } } }, ...errors(400) },
    }), validator("json", GenTitleBody), async (c) =>
      jsonRequest("ExperimentalRoutes.title.generate", c, function* () {
        const body = c.req.valid("json")
        const prompt = yield* SessionPrompt.Service
        return yield* prompt.genTitle(body)
      }),
    )
    .get(
      "/session",
      describeRoute({
        summary: "List sessions",
        description:
          "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
        operationId: "experimental.session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.GlobalInfo.array()),
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
          cursor: z.coerce
            .number()
            .optional()
            .meta({ description: "Return sessions updated before this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
          archived: z.coerce.boolean().optional().meta({ description: "Include archived sessions (default false)" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const limit = query.limit ?? 100
        const sessions: Session.GlobalInfo[] = []
        for await (const session of Session.listGlobal({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          cursor: query.cursor,
          search: query.search,
          limit: limit + 1,
          archived: query.archived,
        })) {
          sessions.push(session)
        }
        const hasMore = sessions.length > limit
        const list = hasMore ? sessions.slice(0, limit) : sessions
        if (hasMore && list.length > 0) {
          c.header("x-next-cursor", String(list[list.length - 1].time.updated))
        }
        return c.json(list)
      },
    )
    .get(
      "/resource",
      describeRoute({
        summary: "Get MCP resources",
        description: "Get all available MCP resources from connected servers. Optionally filter by name.",
        operationId: "experimental.resource.list",
        responses: {
          200: {
            description: "MCP resources",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Resource)),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.resource.list", c, function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.resources()
        }),
    ),
)
