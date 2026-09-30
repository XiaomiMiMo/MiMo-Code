import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

export const PermissionRoutes = lazy(() =>
  new Hono()
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Respond to permission request",
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.reply",
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
          requestID: PermissionID.zod,
        }),
      ),
      validator("json", z.object({ reply: Permission.Reply.zod, message: z.string().optional() })),
      async (c) =>
        jsonRequest("PermissionRoutes.reply", c, function* () {
          const params = c.req.valid("param")
          const json = c.req.valid("json")
          const svc = yield* Permission.Service
          yield* svc.reply({
            requestID: params.requestID,
            reply: json.reply,
            message: json.message,
          })
          return true
        }),
    )
    .get(
      "/",
      describeRoute({
        summary: "List pending permissions",
        description: "Get all pending permission requests across all sessions.",
        operationId: "permission.list",
        responses: {
          200: {
            description: "List of pending permissions",
            content: {
              "application/json": {
                schema: resolver(Permission.Request.zod.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("PermissionRoutes.list", c, function* () {
          const svc = yield* Permission.Service
          return yield* svc.list()
        }),
    )
    .get(
      "/skip-all",
      describeRoute({
        summary: "Get skip-all state",
        description:
          "Whether permission asks are auto-allowed at runtime. Explicit deny rules and forced-ask permissions are unaffected.",
        operationId: "permission.skipAll",
        responses: {
          200: {
            description: "Current skip-all state",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("PermissionRoutes.skipAll", c, function* () {
          const svc = yield* Permission.Service
          return yield* svc.skipAll()
        }),
    )
    .post(
      "/skip-all",
      describeRoute({
        summary: "Set skip-all state",
        description:
          "Enable or disable runtime auto-allow for permission asks. Applies instance-wide, so subagents inherit it. Explicit deny rules and forced-ask permissions (e.g. bash_delete) still apply.",
        operationId: "permission.setSkipAll",
        responses: {
          200: {
            description: "Updated skip-all state",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ enabled: z.boolean().describe("Whether skip-all is enabled") })),
      async (c) =>
        jsonRequest("PermissionRoutes.setSkipAll", c, function* () {
          const svc = yield* Permission.Service
          yield* svc.setSkipAll(c.req.valid("json").enabled)
          return yield* svc.skipAll()
        }),
    )
    .get(
      "/auto-approve-delete",
      describeRoute({
        summary: "Get auto-approve-delete state",
        description:
          "Whether irreversible deletes skip the extra bash_delete confirmation. Instance-scoped; defaults to the MIMOCODE_AUTO_APPROVE_DELETE env var.",
        operationId: "permission.autoApproveDelete",
        responses: {
          200: {
            description: "Current auto-approve-delete state",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("PermissionRoutes.autoApproveDelete", c, function* () {
          const svc = yield* Permission.Service
          return yield* svc.autoApproveDelete()
        }),
    )
    .post(
      "/auto-approve-delete",
      describeRoute({
        summary: "Set auto-approve-delete state",
        description:
          "Trust the model with irreversible deletes, skipping the extra bash_delete confirmation. Distinct from skip-all, which deliberately does NOT cover forced-ask permissions. Applies instance-wide (this directory only, so other directories served by the same process are unaffected) and subagents inherit it. Explicit `bash: deny` rules still block. Already-pending delete asks are left for a human — the command they guard is irreversible.",
        operationId: "permission.setAutoApproveDelete",
        responses: {
          200: {
            description: "Updated auto-approve-delete state",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ enabled: z.boolean().describe("Whether auto-approve-delete is enabled") })),
      async (c) =>
        jsonRequest("PermissionRoutes.setAutoApproveDelete", c, function* () {
          const svc = yield* Permission.Service
          yield* svc.setAutoApproveDelete(c.req.valid("json").enabled)
          return yield* svc.autoApproveDelete()
        }),
    )
    .get(
      "/ask-timeout",
      describeRoute({
        summary: "Get permission ask timeout",
        description:
          "Timeout in milliseconds for permission asks that require human confirmation. null means no timeout (wait indefinitely). Applies to all asks — normal and forced-ask. Orthogonal to skip-all.",
        operationId: "permission.askTimeout",
        responses: {
          200: {
            description: "Current ask timeout in ms, or null",
            content: {
              "application/json": {
                schema: resolver(z.number().nullable()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("PermissionRoutes.askTimeout", c, function* () {
          const svc = yield* Permission.Service
          return yield* svc.permissionAskTimeout()
        }),
    )
    .post(
      "/ask-timeout",
      describeRoute({
        summary: "Set permission ask timeout",
        description:
          "Set the timeout in milliseconds for permission asks that require human confirmation. null disables the timeout (wait indefinitely). Applies instance-wide; subagents inherit it. Orthogonal to skip-all — both can be enabled independently.",
        operationId: "permission.setAskTimeout",
        responses: {
          200: {
            description: "Updated ask timeout in ms, or null",
            content: {
              "application/json": {
                schema: resolver(z.number().nullable()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({ ms: z.number().int().positive().nullable().describe("Timeout in ms, or null to disable") }),
      ),
      async (c) =>
        jsonRequest("PermissionRoutes.setAskTimeout", c, function* () {
          const svc = yield* Permission.Service
          yield* svc.setPermissionAskTimeout(c.req.valid("json").ms)
          return yield* svc.permissionAskTimeout()
        }),
    ),
)
