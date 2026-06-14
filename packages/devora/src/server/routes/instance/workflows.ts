import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { Identifier } from "@/id/id"
import { workflowRef } from "@/workflow/runtime-ref"
import { jsonRequest } from "./trace"
import type { SessionID } from "@/session/schema"

export const WorkflowRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List workflow runs",
        description:
          "List dynamic-workflow runs for a session. sessionID is REQUIRED — there is no per-user identity, so the session is the access boundary and an omitted/invalid sessionID is a 400 (never an unfiltered all-session listing). Empty when the workflow runtime is not running.",
        operationId: "workflow.list",
        responses: {
          200: {
            description: "Workflow runs",
            content: { "application/json": { schema: resolver(z.array(z.any())) } },
          },
        },
      }),
      validator("query", z.object({ sessionID: Identifier.schema("session") })),
      async (c) =>
        jsonRequest("WorkflowRoutes.list", c, function* () {
          const runtime = workflowRef.current
          if (!runtime) return []
          const query = c.req.valid("query")
          return yield* runtime.list({ sessionID: query.sessionID as SessionID })
        }),
    )
    .post(
      "/:runID/resume",
      describeRoute({
        summary: "Resume a workflow run",
        description:
          "Re-launch a persisted workflow run by id. Returns { runID, resumed }; resumed is false if the run is unknown, still running, or has no persisted script.",
        operationId: "workflow.resume",
        responses: {
          200: {
            description: "Resume result",
            content: {
              "application/json": { schema: resolver(z.object({ runID: z.string(), resumed: z.boolean() })) },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          // Strict shape, NOT just startsWith("wf"): runID flows into
          // scriptPath = join(scriptDir, runID + ".js"), so a value like
          // `wf_../../../etc/passwd` (which startsWith "wf") would escape scriptDir.
          // Identifier mints `wf_` + 26 base62 chars; this charset has no `.` or `/`,
          // so it is traversal-proof by construction. The `{26}` tracks
          // Identifier.LENGTH — if that constant ever changes, widen this too (the
          // in-depth persistence guard uses `+`, so it stays correct regardless).
          runID: z.string().regex(/^wf_[0-9A-Za-z]{26}$/, "invalid workflow runID"),
        }),
      ),
      async (c) =>
        jsonRequest("WorkflowRoutes.resume", c, function* () {
          const runtime = workflowRef.current
          const params = c.req.valid("param")
          if (!runtime) return { runID: params.runID, resumed: false }
          return yield* runtime.resume({ runID: params.runID })
        }),
    ),
)
