import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { Identifier } from "@/id/id"
import { workflowRef } from "@/workflow/runtime-ref"
import { jsonRequest } from "./trace"
import type { SessionID } from "@/session/schema"

// Read-only routes (transcript/structure) accept BOTH runID shapes: a top-level
// run is `wf_` + 26 base62 (Identifier.descending), a nested child workflow is
// `wf_` + 64 hex (sha256 of parent runID + key, see runtime.ts). The resume route
// keeps the strict 26-char form because only top-level runs are resumable AND it
// builds a filesystem path from the id; these read routes only do an in-memory
// runtime map lookup, so the wider (still traversal-proof — no `.`/`/`) charset is
// safe here.
const READ_RUN_ID = /^wf_(?:[0-9A-Za-z]{26}|[0-9a-f]{64})$/

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
    )
    .get(
      "/:runID/transcript",
      describeRoute({
        summary: "Get a workflow run's full transcript",
        description:
          "Return the complete ordered phase/log transcript for one run, straight from the runtime's in-memory buffer (uncapped, unlike the tool-part metadata copy). Empty when the runtime is down or the run is unknown.",
        operationId: "workflow.transcript",
        responses: {
          200: {
            description: "Full transcript",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    runID: z.string(),
                    transcript: z.array(z.object({ kind: z.enum(["phase", "log"]), text: z.string() })),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator("param", z.object({ runID: z.string().regex(READ_RUN_ID, "invalid workflow runID") })),
      async (c) =>
        jsonRequest("WorkflowRoutes.transcript", c, function* () {
          const runtime = workflowRef.current
          const params = c.req.valid("param")
          if (!runtime) return { runID: params.runID, transcript: [] }
          const transcript = yield* runtime.transcript({ runID: params.runID })
          return { runID: params.runID, transcript: transcript.slice() }
        }),
    )
    .get(
      "/:runID/structure",
      describeRoute({
        summary: "Get a workflow run's structure tree",
        description:
          "Return the observability-only structure tree (phase/agent/workflow nodes with live status) for one run. Empty when the runtime is down or the run is unknown.",
        operationId: "workflow.structure",
        responses: {
          200: {
            description: "Structure tree",
            content: {
              "application/json": {
                schema: resolver(z.object({ runID: z.string(), nodes: z.array(z.any()) })),
              },
            },
          },
        },
      }),
      validator("param", z.object({ runID: z.string().regex(READ_RUN_ID, "invalid workflow runID") })),
      async (c) =>
        jsonRequest("WorkflowRoutes.structure", c, function* () {
          const runtime = workflowRef.current
          const params = c.req.valid("param")
          if (!runtime) return { runID: params.runID, nodes: [] }
          const s = yield* runtime.structure({ runID: params.runID })
          return { runID: params.runID, nodes: s.nodes }
        }),
    ),
)
