import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import z from "zod"
import { Effect, Fiber } from "effect"
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
  async: z
    .boolean()
    .optional()
    .describe(
      "(optional) When true, return a run_id immediately and let the workflow run in the background; the result arrives later as an inbox notification. Default false: block until terminal and return the transcript inline (skill-like semantics, recommended for short workflows).",
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

type TranscriptEntry = { kind: "phase" | "log"; text: string }
type Metadata = { runID?: string; status?: string; transcript?: TranscriptEntry[] }

// Bound the transcript that gets surfaced to the model (tool output) AND persisted
// to part-state metadata AND streamed in each flush. A chatty workflow
// (deep-research emits a phase + log per source) can otherwise feed tens of KB into
// the model's context, grow the session file without bound, and — because each
// flush pushes a full snapshot through ctx.metadata — make streaming O(N²) in event
// count. Capping the snapshot to head + tail keeps every flush O(1) (so total
// streamed bytes are O(run duration), not O(N²)) and the persisted/displayed view
// bounded, while still showing the start and the most-recent activity.
const TRANSCRIPT_HEAD = 40
const TRANSCRIPT_TAIL = 160
function capTranscript(t: readonly TranscriptEntry[]): TranscriptEntry[] {
  if (t.length <= TRANSCRIPT_HEAD + TRANSCRIPT_TAIL + 1) return t.slice()
  const omitted = t.length - TRANSCRIPT_HEAD - TRANSCRIPT_TAIL
  return [
    ...t.slice(0, TRANSCRIPT_HEAD),
    { kind: "log", text: `…(${omitted} lines omitted)` },
    ...t.slice(t.length - TRANSCRIPT_TAIL),
  ]
}

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
          // Only the async (background) path relies on the inbox notification; the
          // sync path below returns the result inline, so suppress the duplicate.
          notifyOnTerminal: input.async === true,
        })
        const runID = started.runID
        const label = input.name ?? "inline"

        // Async opt-out: legacy fire-and-forget semantic. Returns the run_id
        // immediately and lets the workflow keep running in the background; the
        // terminal result arrives later as an inbox notification on the parent's
        // next turn. Use this for very long workflows (deep-research, etc.) where
        // blocking the agent's turn for the full duration is undesirable.
        if (input.async === true) {
          return {
            title: "workflow started",
            output: `Workflow started in background. run_id: ${runID}\nThe result will be delivered as a notification when complete.`,
            metadata: { runID, status: "running" } satisfies Metadata,
          }
        }

        // Default sync path: block until terminal so the model + user see phase
        // and log() events as the tool's own message stream (skill-like) instead
        // of a bare run_id followed by silence until the next turn drains the
        // inbox. We read the transcript from the runtime's authoritative per-run
        // buffer (populated synchronously by the guest hooks) rather than
        // subscribing to the bus: that avoids the subscribe-after-start head race,
        // cross-event reordering, the post-wait tail race, and any subscription
        // leak on interrupt. The buffer flushes to part-state metadata as it grows
        // — the TUI re-renders each delta via the existing message.part.delta path.
        yield* ctx.metadata({
          metadata: { runID, status: "running", transcript: [] } satisfies Metadata,
        })

        // A 250ms flush loop reads the runtime's transcript and pushes a CAPPED
        // snapshot through ctx.metadata (reusing the per-part-state delta channel,
        // so TUI consumers need no new subscription). The cap keeps each delta
        // bounded regardless of event count. forkScoped binds the fiber to the
        // execute scope below, so it is interrupted on completion OR interrupt.
        let lastLen = 0
        const flushFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep("250 millis")
              const t = yield* runtime.transcript({ runID })
              if (t.length === lastLen) continue
              lastLen = t.length
              yield* ctx.metadata({
                metadata: { runID, status: "running", transcript: capTranscript(t) } satisfies Metadata,
              })
            }
          }),
        )

        const outcome = yield* runtime.wait({ runID })
        yield* Fiber.interrupt(flushFiber)

        // The guest hooks append synchronously and complete before the script
        // returns (which resolves wait()), so this snapshot is the full, ordered
        // transcript. Cap it for both the model-facing output and persisted metadata.
        const finalTranscript = capTranscript(yield* runtime.transcript({ runID }))
        const lines = finalTranscript.map((e) => (e.kind === "phase" ? `▸ ${e.text}` : `  ${e.text}`))
        if (outcome.status === "completed") {
          const result = JSON.stringify(outcome.result ?? null)
          const truncated = result.length > 4000 ? result.slice(0, 4000) + " …(truncated)" : result
          return {
            title: `workflow ${label} completed`,
            output:
              (lines.length ? lines.join("\n") + "\n\n" : "") +
              `Result: ${truncated}\nrun_id: ${runID}`,
            metadata: { runID, status: "completed", transcript: finalTranscript } satisfies Metadata,
          }
        }
        if (outcome.status === "failed") {
          return {
            title: `workflow ${label} failed`,
            output:
              (lines.length ? lines.join("\n") + "\n\n" : "") +
              `Error: ${outcome.error}\nrun_id: ${runID}`,
            metadata: { runID, status: "failed", transcript: finalTranscript } satisfies Metadata,
          }
        }
        return {
          title: `workflow ${label} cancelled`,
          output:
            (lines.length ? lines.join("\n") + "\n\n" : "") + `Cancelled.\nrun_id: ${runID}`,
          metadata: { runID, status: "cancelled", transcript: finalTranscript } satisfies Metadata,
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
      execute: (input: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
        run(input, ctx).pipe(Effect.scoped, Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
