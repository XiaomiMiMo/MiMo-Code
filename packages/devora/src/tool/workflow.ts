import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import z from "zod"
import { Effect } from "effect"
import { Config } from "../config"
import { workflowRef } from "@/workflow/runtime-ref"
import { BuiltinWorkflow } from "@/workflow/builtin"
import type { SessionID } from "../session/schema"

const id = "workflow"

const runSchema = z.strictObject({
  operation: z.literal("run"),
  name: z
    .string()
    .min(1)
    .optional()
    .describe(
      '(optional) Name of a built-in workflow to run (e.g. "deep-research"). Provide EITHER name OR script, not both.',
    ),
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
      "(optional) Inline JS workflow script; must begin with `export const meta = {...}`. Provide EITHER name OR script, not both.",
    ),
  args: z.any().optional().describe("(optional) JSON value exposed to the script as `args`."),
  workspace: z
    .string()
    .optional()
    .describe(
      "(optional) Absolute dir the script's file primitives (readFile/writeFile/glob/exists) are jailed to. Defaults to the project worktree.",
    ),
})
const statusSchema = z.strictObject({ operation: z.literal("status"), run_id: z.string().min(1) })
const waitSchema = z.strictObject({
  operation: z.literal("wait"),
  run_id: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
})
const cancelSchema = z.strictObject({ operation: z.literal("cancel"), run_id: z.string().min(1) })
const resumeSchema = z.strictObject({ operation: z.literal("resume"), run_id: z.string().min(1) })

export const parameters = z.discriminatedUnion("operation", [
  runSchema,
  statusSchema,
  waitSchema,
  cancelSchema,
  resumeSchema,
])

type Metadata = { runID?: string; status?: string }

export const WorkflowTool = Tool.define<typeof parameters, Metadata, Config.Service>(
  id,
  Effect.gen(function* () {
    const config = yield* Config.Service

    // Resolve the WorkflowRuntime through the late-bound workflowRef rather than as
    // a Layer dependency: pulling WorkflowRuntime.Service in here would push that
    // requirement onto ToolRegistry.layer, forcing every layer that builds the
    // registry to provide it. The ref is populated by WorkflowRuntime.layer's
    // initialiser (see workflow/runtime-ref.ts) — mirrors the actor tool's spawnRef.
    const requireRuntime = () => {
      const runtime = workflowRef.current
      if (!runtime) {
        return Effect.fail(
          new Error(
            "Workflow runtime unavailable — WorkflowRuntime.defaultLayer must be running for the workflow tool",
          ),
        )
      }
      return Effect.succeed(runtime)
    }

    const run = Effect.fn("WorkflowTool.execute")(function* (
      input: z.infer<typeof parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const runtime = yield* requireRuntime()

      if (input.operation === "run") {
        const cfg = yield* config.get()
        // The schema keeps both `name` and `script` optional; enforce the xor
        // here. Both-provided is a caller mistake (the schema docstring says
        // "EITHER name OR script, not both") — fail loudly rather than silently
        // picking one. Effect.orDie surfaces it to the model.
        if (input.name && input.script) {
          return yield* Effect.fail(
            new Error("workflow run: provide either `name` (a built-in) or `script` (inline), not both."),
          )
        }
        const script = input.name ? BuiltinWorkflow.get(input.name)?.script : input.script
        if (!script) {
          const known = BuiltinWorkflow.list()
            .map((w) => w.name)
            .join(", ")
          return yield* Effect.fail(
            new Error(
              input.name
                ? `Unknown built-in workflow "${input.name}". Known: ${known || "(none)"}.`
                : "workflow run requires either `name` (a built-in) or `script` (inline).",
            ),
          )
        }
        const started = yield* runtime.start({
          script,
          sessionID: ctx.sessionID as SessionID,
          parentActorID: ctx.agent ?? "main",
          args: input.args,
          workspace: input.workspace,
          maxConcurrentAgents: cfg.workflow?.maxConcurrentAgents,
          scriptDeadlineMs: cfg.workflow?.scriptDeadlineMs,
        })
        return {
          title: "workflow started",
          output: `Workflow started. run_id: ${started.runID}\nThe result will be delivered as a notification when complete.`,
          metadata: { runID: started.runID } satisfies Metadata,
        }
      }
      if (input.operation === "status") {
        const snapshot = yield* runtime.status({ runID: input.run_id })
        return {
          title: `workflow ${snapshot.status}`,
          output: JSON.stringify(snapshot),
          metadata: { runID: input.run_id, status: snapshot.status } satisfies Metadata,
        }
      }
      if (input.operation === "wait") {
        const outcome = yield* runtime.wait({ runID: input.run_id, timeoutMs: input.timeout_ms })
        return {
          title: `workflow ${outcome.status}`,
          output: JSON.stringify(outcome),
          metadata: { runID: input.run_id, status: outcome.status } satisfies Metadata,
        }
      }
      if (input.operation === "cancel") {
        yield* runtime.cancel({ runID: input.run_id })
        return {
          title: "workflow cancelled",
          output: `Cancelled ${input.run_id}`,
          metadata: { runID: input.run_id, status: "cancelled" } satisfies Metadata,
        }
      }
      if (input.operation === "resume") {
        const resumed = yield* runtime.resume({ runID: input.run_id })
        return {
          title: resumed.resumed ? "workflow resumed" : "workflow not resumable",
          output: JSON.stringify(resumed),
          metadata: { runID: input.run_id } satisfies Metadata,
        }
      }
      input satisfies never
      throw new Error(`unhandled workflow operation: ${(input as { operation: string }).operation}`)
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (input: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) => run(input, ctx).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
