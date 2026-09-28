import * as Tool from "./tool"
import { RecoverableError } from "./recoverable"
import DESCRIPTION from "./actor.txt"
import DESCRIPTION_CHECKPOINT from "./actor.checkpoint.txt"
import { withCheckpointDescription } from "./checkpoint-description"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID, PartID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Provider } from "../provider"
import { sortVisionModels } from "../provider/provider"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { ActorRegistry } from "@/actor/registry"
import { ActorWaiter } from "@/actor/waiter"
import { spawnRef } from "@/actor/spawn-ref"
import { TaskRegistry } from "@/task/registry"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"
import { TaskID } from "@/task/schema"
import { EffectBridge } from "@/effect"
import { inboxServiceRef } from "@/inbox/inbox-ref"
import { turnQueueRef } from "@/turn-queue"
import { Effect, Deferred } from "effect"

export interface ActorPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "actor"

const MODEL_PARAM_DESCRIPTION =
  "(optional) Model for this subagent: a model group name (e.g. ultra/standard/lite) or a literal provider/model (e.g. mimo-v2.5-pro). Overrides the agent's configured model; defaults to the agent's model, else the parent's. If no model_groups are configured, the tier names resolve to the default model. To discover valid provider/model values (e.g. a vision-capable model for image tasks), run `actor models` (or `actor models --vision`)."

export const ActorTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const actorRegistry = yield* ActorRegistry.Service
    const waiter = yield* ActorWaiter.Service
    const tasks = yield* TaskRegistry.Service

    // Resolve the Actor service through the late-bound spawnRef rather than as
    // a Layer dependency: pulling Actor.Service in here would create a layer
    // cycle (Actor → SessionPrompt → ToolRegistry → tool/actor → Actor) that
    // Effect cannot satisfy. The ref is populated by Actor.layer's initialiser
    // (see actor/spawn-ref.ts).
    const requireActor = () => {
      const a = spawnRef.current
      if (!a) {
        return Effect.fail(
          new Error(
            "Actor service unavailable — Actor.appLayer must be running for the actor tool to spawn or cancel actors",
          ),
        )
      }
      return Effect.succeed(a)
    }

    // Tool def is built lazily (function form of Init) because the dynamic
    // `subagent_type` enum below calls agent.list(), which queries
    // InstanceState — Instance is only available at tool-init time
    // (per-invocation), not at service-resolution time when ActorTool is
    // wired into ToolRegistry's layer.
    return Effect.fn("ActorTool.init")(function* () {
      // F36a: build subagent_type as a dynamic z.enum from the agent registry,
      // filtered to spawnable agents (mode === "subagent" && !hidden). Excludes
      // hidden internals (title, summary, checkpoint-writer per F24) and
      // includes both native registry agents (general/explore) and
      // user-config-defined subagents. This gives the LLM a discoverable,
      // validated list of agent types — replaces the prior bare z.string()
      // that the model couldn't introspect (root cause of three harness runs
      // with zero subagent spawns).
      const allAgents = yield* agent.list()
      const spawnable = allAgents.filter((a) => a.mode === "subagent" && !a.hidden)
      const spawnableNames = spawnable.map((a) => a.name)
      if (spawnableNames.length === 0) {
        return yield* Effect.die(new Error("No spawnable subagent types"))
      }
      const subagentTypeEnum = z.enum(spawnableNames as [string, ...string[]])

      const actorIdRequiredField = z
        .string()
        .min(1)
        .describe(
          "Actor session id to operate on. Distinct from the user-task IDs (T1, T2, ...) used by the `task` tool.",
        )

      const timeoutField = z
        .number()
        .int()
        .positive()
        .optional()
        .describe("(optional) Milliseconds to wait before returning { status: 'timeout' }. Default 600000 (10 min).")

      const runSchema = z.strictObject({
        action: z
          .literal("run")
          .describe(
            "RARE EXCEPTION — launches a subagent and waits for its inline result until completion, user input, or timeout. Interruption and timeout release the wait without cancelling the subagent. Use it only when you cannot make your very next decision without the result in THIS turn and the work is a tiny, fast lookup. For ordinary analysis, review, or implementation work use `spawn` instead.",
          ),
        description: z.string().min(1).describe("A short (3-5 words) description of the task."),
        prompt: z.string().min(1).describe("The task for the agent to perform."),
        subagent_type: subagentTypeEnum.describe("The type of specialized agent to use for this task."),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(MODEL_PARAM_DESCRIPTION),
        timeout_ms: timeoutField,
        command: z.string().min(1).optional().describe("(optional) The command that triggered this task."),
        task_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(optional) If this subagent is doing work for a specific task in the `task` tool, pass that task's ID (e.g. T4, T2.1) here — only an ID the `task` tool returned this session. After completion, the actor.postStop hook validates that tasks/<task_id>/progress.md exists with the required sections. If the ID is malformed or names no existing task, the binding is silently dropped and the subagent's findings are NOT captured to that task. Leave omitted only for work that isn't tied to a task.",
          ),
        output_schema: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "(optional) A JSON Schema. When set, the subagent is forced to return a single structured object matching this schema (via the StructuredOutput tool) instead of free text; the validated object is returned in <actor_result>.",
          ),
      })

      const spawnSchema = z.strictObject({
        action: z
          .literal("spawn")
          .describe(
            "THE DEFAULT — launches a subagent in the BACKGROUND and returns its actor_id immediately, so subagents run in PARALLEL and you keep responding to the user. The result arrives as a notification, or collect it with `wait`/`status`.",
          ),
        description: z.string().min(1).describe("A short (3-5 words) description of the task."),
        prompt: z.string().min(1).describe("The task for the agent to perform."),
        subagent_type: subagentTypeEnum.describe("The type of specialized agent to use for this task."),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(MODEL_PARAM_DESCRIPTION),
        command: z.string().min(1).optional().describe("(optional) The command that triggered this task."),
        task_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(optional) If this subagent is doing work for a specific task in the `task` tool, pass that task's ID (e.g. T4, T2.1) here — only an ID the `task` tool returned this session. After completion, the actor.postStop hook validates that tasks/<task_id>/progress.md exists with the required sections. If the ID is malformed or names no existing task, the binding is silently dropped and the subagent's findings are NOT captured to that task. Leave omitted only for work that isn't tied to a task.",
          ),
        output_schema: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "(optional) A JSON Schema. When set, the subagent is forced to return a single structured object matching this schema (via the StructuredOutput tool) instead of free text.",
          ),
      })

      const statusSchema = z.strictObject({
        action: z.literal("status"),
        actor_id: actorIdRequiredField,
      })

      const waitSchema = z.strictObject({
        action: z.literal("wait"),
        actor_id: actorIdRequiredField,
        timeout_ms: timeoutField,
      })

      const cancelSchema = z.strictObject({
        action: z.literal("cancel"),
        actor_id: actorIdRequiredField,
      })

      const sendSchema = z.strictObject({
        action: z.literal("send"),
        to_session_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(optional) Target session ID. Defaults to the current session — useful for sending to subagents in this session.",
          ),
        to_actor_id: z
          .string()
          .min(1)
          .describe(
            "Target actor ID. Use 'main' to send to a session's main agent, or a subagent ID like 'explore-1'.",
          ),
        content: z.string().min(1).describe("Message content (plain text). Wrapped in <inbox> for the receiver."),
        type: z
          .string()
          .optional()
          .describe(
            "(optional) Message type. Default 'text' is wrapped in <inbox>...</inbox>. 'actor_notification' is passed through verbatim (sender pre-renders).",
          ),
      })

      const modelsSchema = z.strictObject({
        action: z.literal("models"),
        vision: z.boolean().optional().describe("(optional) If true, list only vision-capable models (models that accept image input)."),
        limit: z.number().int().positive().optional().describe("(optional) Max number of models to return. Default 50."),
      })

      const parameters = z.strictObject({
        // .meta({ type: "object" }) is REQUIRED — without it the emitted JSON
        // schema's `operation` node has only `anyOf`, no `type`, and some models
        // (notably mimo-v2.5-pro) stringify the whole envelope
        // ({"operation":"{\"action\":\"run\",...}"}) which fails zod validation.
        // The root strictObject also means flattenDiscriminatedUnion finds no
        // root-level union and passes through unchanged — root keeps exactly one
        // key (`operation`), so models can't drop the discriminator.
        operation: z
          .discriminatedUnion("action", [
            // spawn first: it is the default action, and the model reads this
            // union in order. run stays available but is listed as the exception.
            spawnSchema,
            runSchema,
            statusSchema,
            waitSchema,
            cancelSchema,
            sendSchema,
            modelsSchema,
          ])
          .meta({ type: "object" }),
      })

      const run = Effect.fn("ActorTool.execute")(function* (input: z.infer<typeof parameters>, ctx: Tool.Context) {
        const op = input.operation
        const bridge = yield* EffectBridge.make()
        const cfg = yield* config.get()

        // When called through exec, subagents may only use `send` to communicate
        // with the parent. All other actions (spawn, run, cancel, status, wait,
        // models) are restricted to primary agents. Peer actors have a primary
        // agent type so they are unaffected by this guard.
        if (ctx.extra?.fromExec) {
          const caller = yield* agent.get(ctx.agent)
          if (caller?.mode === "subagent" && op.action !== "send") {
            return yield* Effect.fail(
              new RecoverableError(
                `Subagents can only use actor send to communicate with the parent agent. You are running as "${caller.name}"; use actor send with to_actor_id="main" to report progress or findings.`,
              ),
            )
          }
        }

        // Helper: "actor belongs to another session OR doesn't exist" response.
        // Same response for both cases — don't leak the difference (POSIX: you can
        // only reap your own children).
        const unknownResponse = (label: string, actorID: string) => {
          const snapshot = { status: "unknown" as const, actor_id: actorID }
          return {
            title: `Actor ${label}: unknown`,
            output: JSON.stringify(snapshot),
            metadata: { actor_id: actorID, status: "unknown" } as Record<string, any>,
          }
        }

        // Look up an actor in the registry. Subagent actors live under
        // ctx.sessionID; peer actors live under their own sessionID (== actorID).
        // Try the subagent location first, then fall back to the peer location.
        const findActor = Effect.fn("ActorTool.findActor")(function* (actorID: string) {
          const sub = yield* actorRegistry.get(ctx.sessionID, actorID)
          if (sub) return { entry: sub, sessionID: ctx.sessionID }
          const sid = SessionID.make(actorID)
          const peer = yield* actorRegistry.get(sid, actorID)
          if (peer) return { entry: peer, sessionID: sid }
          return undefined
        })

        if (op.action ==="send") {
          const inboxSvc = inboxServiceRef.current
          if (!inboxSvc) {
            return yield* Effect.fail(
              new Error("Inbox service unavailable — Inbox.layer must be running for the actor tool to send messages"),
            )
          }
          const targetSid = op.to_session_id !== undefined ? SessionID.make(op.to_session_id) : ctx.sessionID
          const sendResult = yield* inboxSvc
            .send({
              receiverSessionID: targetSid,
              receiverActorID: op.to_actor_id,
              senderSessionID: ctx.sessionID,
              senderActorID: ctx.agent ?? "main",
              content: op.content,
              ...(op.type !== undefined ? { type: op.type } : {}),
            })
            .pipe(
              Effect.catchTag("InboxReceiverNotFound", () =>
                Effect.succeed({ inboxID: null as string | null, error: "receiver not found" }),
              ),
            )
          if ("error" in sendResult) {
            return {
              title: `Send failed: receiver not found`,
              output: JSON.stringify(sendResult),
              metadata: {
                receiver_actor_id: op.to_actor_id,
                receiver_session_id: targetSid,
                error: sendResult.error,
              } as Record<string, any>,
            }
          }
          return {
            title: `Sent to ${op.to_actor_id}`,
            output: JSON.stringify({ inboxID: sendResult.inboxID }),
            metadata: {
              inboxID: sendResult.inboxID,
              receiver_actor_id: op.to_actor_id,
              receiver_session_id: targetSid,
            } as Record<string, any>,
          }
        }

        if (op.action ==="status") {
          const found = yield* findActor(op.actor_id)
          if (!found) return unknownResponse("status", op.actor_id)
          const entry = yield* waiter.status(found.entry)
          const snapshot = {
            status: entry.status,
            executionActive: entry.executionActive,
            executionState: entry.executionState,
            actor_id: entry.actorID,
            description: entry.description,
            agent: entry.agent,
            background: entry.background,
            turnCount: entry.turnCount,
            lastTurnTime: entry.lastTurnTime,
            lastOutcome: entry.lastOutcome,
            ...(entry.lastError !== undefined ? { error: entry.lastError } : {}),
            time: entry.time,
          }
          return {
            title: `Actor status: ${entry.executionState}`,
            output: JSON.stringify(snapshot),
            metadata: { actor_id: entry.actorID, status: entry.status } as Record<string, any>,
          }
        }

        if (op.action ==="wait") {
          const found = yield* findActor(op.actor_id)
          if (!found) return unknownResponse("wait", op.actor_id)
          const snap = yield* waiter.wait({
            sessionID: found.sessionID,
            actor_id: op.actor_id,
            timeout_ms: op.timeout_ms,
          })
          const title =
            snap.status === "interrupted"
              ? "Actor wait: interrupted by user message"
              : `Actor wait: ${snap.status}${snap.lastOutcome ? "/" + snap.lastOutcome : ""}`
          const output =
            snap.status === "interrupted"
              ? JSON.stringify(snap) + "\n" + ActorWaiter.WAIT_INTERRUPTED_HINT
              : JSON.stringify(snap.status === "timeout" ? { ...snap, hint: ActorWaiter.WAIT_TIMEOUT_HINT } : snap)
          return {
            title,
            output,
            metadata: {
              actor_id: snap.actor_id,
              status: snap.status,
              ...(snap.lastOutcome ? { lastOutcome: snap.lastOutcome } : {}),
            } as Record<string, any>,
          }
        }

        if (op.action ==="cancel") {
          const found = yield* findActor(op.actor_id)
          if (!found) return unknownResponse("cancel", op.actor_id)
          const entry = found.entry

          // Already terminal? No-op — return current status. Idempotent.
          if (entry.status === "idle") {
            const snapshot = {
              status: entry.status,
              actor_id: entry.actorID,
              description: entry.description,
              agent: entry.agent,
              background: entry.background,
            }
            return {
              title: `Actor cancel: ${entry.status}`,
              output: JSON.stringify(snapshot),
              metadata: { actor_id: entry.actorID, status: entry.status } as Record<string, any>,
            }
          }

          // Signal the actor through Actor.cancel — marks status "cancelled" in the registry.
          const actorForCancel = yield* requireActor()
          yield* actorForCancel.cancel(found.sessionID, entry.actorID, "graceful")

          const snapshot = {
            status: "cancelled" as const,
            actor_id: entry.actorID,
            description: entry.description,
            agent: entry.agent,
            background: entry.background,
          }
          return {
            title: `Actor cancel: cancelled`,
            output: JSON.stringify(snapshot),
            metadata: { actor_id: entry.actorID, status: "cancelled" } as Record<string, any>,
          }
        }

        if (op.action === "models") {
          const providers = yield* provider.list()
          const allModels = Object.values(providers).flatMap((info) => Object.values(info.models))
          const filtered = op.vision ? allModels.filter((m) => m.capabilities.input.image === true) : allModels
          const ordered = op.vision
            ? sortVisionModels(filtered)
            : [...filtered].sort((a, b) => `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`))
          const limit = op.limit ?? 50
          const shown = ordered.slice(0, limit)
          const lines = shown.map((m) => `${m.providerID}/${m.id}${m.capabilities.input.image ? " (vision)" : ""}`)
          const header = op.vision ? `Vision-capable models` : `Available models`
          const more = ordered.length > shown.length ? `\n… and ${ordered.length - shown.length} more (raise --limit)` : ""
          const output = shown.length === 0
            ? (op.vision ? "No vision-capable models are configured. Configure a vision model or use an OCR tool." : "No models are configured.")
            : `${header} (${shown.length} of ${ordered.length}):\n${lines.join("\n")}${more}\nPass any of these to actor --model.`
          return { title: header, output, metadata: { count: shown.length, total: ordered.length, vision: !!op.vision } as Record<string, any> }
        }

        // op.action ==="run" or "spawn" — schema guarantees
        // description / prompt / subagent_type are present and non-empty.
        //
        // Final defence line for the no-nested-delegation invariant that
        // ToolRegistry.available already enforces by masking `actor` out of every
        // subagent's schema: refuse a spawn whose caller is itself a subagent, so
        // a stale prompt-cached schema or a hand-rolled call site cannot recurse.
        // bypassAgentCheck marks a dispatch that did NOT originate from a model
        // deciding to delegate — handleSubtask (where ctx.agent is the CHILD being
        // spawned, not the caller) and explicit user @agent mentions — so those
        // legitimately pass through.
        if (!ctx.extra?.bypassAgentCheck) {
          const caller = yield* agent.get(ctx.agent)
          if (caller?.mode === "subagent" && !SYSTEM_SPAWNED_AGENT_TYPES.has(caller.name)) {
            return yield* Effect.fail(
              new RecoverableError(
                `Subagents cannot spawn other subagents. You are running as "${caller.name}"; complete this task yourself with the tools available to you.`,
              ),
            )
          }
          yield* ctx.ask({
            permission: "actor",
            patterns: [op.subagent_type],
            always: ["*"],
            metadata: {
              description: op.description,
              subagent_type: op.subagent_type,
            },
          })
        }

        const next = yield* agent.get(op.subagent_type)
        if (!next) {
          return yield* Effect.fail(
            new RecoverableError(
              `Unknown agent type "${op.subagent_type}". Valid subagent_type values are listed in the actor tool description — pass one of those.`,
            ),
          )
        }

        const prompt = op.prompt

        const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
        if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

        const modelRef = op.model ?? next.modelRef
        const model = modelRef
          ? yield* provider
              .resolveModelRef(modelRef, msg.info.providerID)
              .pipe(Effect.map((m) => ({ modelID: m.id, providerID: m.providerID })))
          : (next.model ?? {
              modelID: msg.info.modelID,
              providerID: msg.info.providerID,
            })

        // Validate task_id by reference at execute time (NOT in the schema, so a
        // bad value degrades instead of hard-failing the call). A malformed shape
        // or an ID that names no task in this session ⇒ run ad-hoc (task_id
        // dropped) and tell the model why, so a fabricated ID becomes harmless
        // instead of triggering phantom postStop progress nagging.
        let effectiveTaskId = op.task_id
        let taskNotice = ""
        if (op.task_id) {
          if (!TaskID.safeParse(op.task_id).success) {
            effectiveTaskId = undefined
            taskNotice = `note: task_id "${op.task_id}" is not a valid task ID (expected Tn or Tn.m); ran ad-hoc. Task IDs come from the \`task\` tool.`
          } else {
            const existing = yield* tasks.get({ session_id: ctx.sessionID, id: op.task_id })
            if (!existing) {
              effectiveTaskId = undefined
              taskNotice = `note: task_id "${op.task_id}" does not exist in this session; ran ad-hoc. Create it with the \`task\` tool first, or omit task_id.`
            }
          }
        }

        // v6: subagents share the parent's sessionID and run as registered actors
        // under the parent. Actor.spawn handles registry registration, forking
        // the agent loop, and sending inbox notifications on terminal — replacing
        // the legacy session.create + manual fork path that lived here pre-Task-29.
        const actor = yield* requireActor()
        let actorID: string | undefined
        let afterRevision: number | undefined
        const notifyOnCompletion = op.action === "run"
          ? yield* Effect.acquireRelease(Deferred.make<boolean>(), (decision) => Deferred.succeed(decision, false))
          : undefined
        if (op.action === "run") {
          function cancelHandler() {
            if (actorID) bridge.fork(actor.cancel(ctx.sessionID, actorID, "graceful"))
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => ctx.abort.addEventListener("abort", cancelHandler)),
            () => Effect.sync(() => ctx.abort.removeEventListener("abort", cancelHandler)),
          )
          if (ctx.abort.aborted) return yield* Effect.interrupt
          const tq = turnQueueRef.current
          if (tq) afterRevision = yield* tq.observeInput({ sessionID: ctx.sessionID, agentID: "main" }, -1)
        }
        const spawnResult = yield* actor.spawn({
          mode: "subagent",
          sessionID: ctx.sessionID,
          agentType: next.name,
          description: op.description,
          task: prompt,
          context: "none",
          tools: next.toolAllowlist ? [...next.toolAllowlist] : "INHERIT",
          model,
          // run owns an interruptible wait; the child must outlive it and still notify.
          background: true,
          notifyOnCompletion,
          task_id: effectiveTaskId,
          onActorID: (id) => {
            actorID = id
            if (op.action === "run" && ctx.abort.aborted)
              bridge.fork(actor.cancel(ctx.sessionID, id, "graceful"))
          },
          onReady: ({ actorID, sessionID }) =>
            ctx.metadata({
              title: op.description,
              metadata: { sessionId: sessionID, actorId: actorID, model },
            }),
          ...(op.output_schema
            ? { format: { type: "json_schema" as const, schema: op.output_schema, retryCount: 2 } }
            : {}),
        })

        if (op.action ==="spawn") {
          return {
            title: op.description,
            metadata: { sessionId: spawnResult.sessionID, actorId: spawnResult.actorID, model },
            output:
              (taskNotice ? taskNotice + "\n" : "") +
              `Background sub-session started. actor_id: ${spawnResult.actorID}\nThe result will be delivered as a notification when complete.`,
          }
        }

        const snap = yield* waiter.wait({
          sessionID: spawnResult.sessionID,
          actor_id: spawnResult.actorID,
          timeout_ms: op.timeout_ms,
          afterRevision,
        }).pipe(Effect.raceFirst(Deferred.await(spawnResult.outcome).pipe(Effect.as(undefined))))
        if (snap && (snap.status === "interrupted" || snap.status === "timeout")) {
          if (notifyOnCompletion) yield* Deferred.succeed(notifyOnCompletion, !ctx.abort.aborted)
          return {
            title: snap.status === "interrupted" ? "Actor run: interrupted by user message" : "Actor run: timeout",
            metadata: {
              sessionId: spawnResult.sessionID,
              actorId: spawnResult.actorID,
              actor_id: spawnResult.actorID,
              status: snap.status,
              model,
            } as Record<string, any>,
            output:
              (taskNotice ? taskNotice + "\n" : "") +
              (snap.status === "interrupted"
                ? JSON.stringify(snap) + "\n" + ActorWaiter.WAIT_INTERRUPTED_HINT
                : JSON.stringify({ ...snap, hint: ActorWaiter.WAIT_TIMEOUT_HINT })),
          }
        }
        // Only spawn's reconciled outcome is authoritative. If execution exits
        // without publishing it, never wait again or substitute a registry outcome.
        if (!(yield* Deferred.isDone(spawnResult.outcome))) {
          return yield* Effect.fail(
            new Error(`Actor ${spawnResult.actorID} exited without an authoritative outcome: ${JSON.stringify(snap)}`),
          )
        }
        const outcome = yield* Deferred.await(spawnResult.outcome)

        // Blocking run preserves the pre-unification contract: tool call fails
        // when the child fails. The LLM sees a tool error, not a "success with
        // error in output." (The explicit action="wait" returns the structured
        // snapshot as a regular tool result — that's a different contract.)
        if (outcome.status === "failure") {
          const partial = outcome.structured !== undefined ? JSON.stringify(outcome.structured) : outcome.finalText
          return yield* Effect.fail(new Error(`Tool execution failed: ${outcome.error ?? "unknown"}${partial === undefined ? "" : `\nPartial result: ${partial}`}`))
        }

        const resultText =
          outcome.status === "success"
            ? outcome.structured !== undefined
              ? JSON.stringify(outcome.structured)
              : (outcome.finalText ?? "(no output)")
            : "<cancelled>task was cancelled</cancelled>"
        const statusAttr = outcome.status === "success" ? (outcome.reportedStatus ?? "unknown") : outcome.status
        const summaryAttr =
          outcome.status === "success" && outcome.reportedSummary
            ? ` summary="${outcome.reportedSummary.replace(/\s+/g, " ").replace(/"/g, "'").trim()}"`
            : ""
        return {
          title: op.description,
          metadata: { sessionId: spawnResult.sessionID, actorId: spawnResult.actorID, model } as Record<string, any>,
          output: [
            ...(taskNotice ? [taskNotice, ""] : []),
            `actor_id: ${spawnResult.actorID} (to give this subagent more work, \`send\` it another message)`,
            "",
            `<actor_result status="${statusAttr}"${summaryAttr}>`,
            resultText,
            "</actor_result>",
            ...(outcome.status === "success" ? (outcome.warnings ?? []).map((warning) => `Warning: ${warning}`) : []),
          ].join("\n"),
        }
      }, Effect.scoped)

      return {
        description: withCheckpointDescription(DESCRIPTION, DESCRIPTION_CHECKPOINT),
        parameters,
        execute: (input: z.infer<typeof parameters>, ctx: Tool.Context) => run(input, ctx).pipe(Effect.orDie),
      }
    })
  }),
)
