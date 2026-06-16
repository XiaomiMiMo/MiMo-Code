import * as Tool from "./tool"
import { RecoverableError } from "./recoverable"
import DESCRIPTION from "./actor.txt"
import SHELL_DESCRIPTION from "./actor.shell.txt"
import { tokenize } from "./shell-tokenize"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID, PartID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Provider } from "../provider"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { ActorRegistry } from "@/actor/registry"
import { ActorWaiter } from "@/actor/waiter"
import { spawnRef } from "@/actor/spawn-ref"
import { TaskRegistry } from "@/task/registry"
import { TaskID } from "@/task/schema"
import { SessionCheckpoint } from "@/session/checkpoint"
import { inboxServiceRef } from "@/inbox/inbox-ref"
import { Effect, Deferred } from "effect"

export interface ActorPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "actor"

const MODEL_PARAM_DESCRIPTION =
  "(optional) Model for this subagent: a model group name (e.g. ultra/standard/lite) or a literal provider/model (e.g. mimo-v2.5-pro). Overrides the agent's configured model; defaults to the agent's model, else the parent's. If no model_groups are configured, the tier names resolve to the default model."

const KNOWN_ACTOR_VERBS = ["run", "spawn", "status", "wait", "cancel", "send"]

function levenshteinActor(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function suggestActorVerb(input: string): string | undefined {
  const candidates = KNOWN_ACTOR_VERBS.map((v) => ({ v, d: levenshteinActor(input, v) })).filter((c) => c.d <= 2)
  if (candidates.length !== 1) return undefined
  return candidates[0].v
}

// Static args type for shell parsing — mirrors the discriminated union shape but
// uses z.string() for subagent_type since the dynamic enum is only needed at
// Zod validation time (inside execute), not at parse time.
type ActorShellArgs =
  | { operation: { action: "run"; subagent_type: string; description: string; prompt: string; model?: string; task_id?: string; actor_id?: string; timeout_ms?: number; command?: string; context?: "none" | "state" | "full"; output_schema?: Record<string, unknown> } }
  | { operation: { action: "spawn"; subagent_type: string; description: string; prompt: string; model?: string; task_id?: string; actor_id?: string; command?: string; context?: "none" | "state" | "full"; output_schema?: Record<string, unknown> } }
  | { operation: { action: "status"; actor_id: string } }
  | { operation: { action: "wait"; actor_id: string; timeout_ms?: number } }
  | { operation: { action: "cancel"; actor_id: string } }
  | { operation: { action: "send"; to_actor_id: string; content: string; to_session_id?: string; type?: string } }

function actorArityError(verb: string, expected: string, args: string[], line: number) {
  return Effect.fail({
    kind: "arity",
    line,
    detail: `actor: ${verb}: arity mismatch\n  got:      actor ${verb} ${args.join(" ")}\n  expected: actor ${verb} ${expected}`,
  })
}

// Generic `--name value` / `--name=value` extractor for a fixed set of optional
// flags. Positionals (and any unrecognized tokens) fall through to `rest`.
function extractNamedFlags(
  args: string[],
  names: string[],
  line: number,
): Effect.Effect<{ flags: Record<string, string>; rest: string[] }, { kind: "flag"; line: number; detail: string }> {
  const rest: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const bare = names.find((n) => a === `--${n}`)
    if (bare) {
      const next = args[i + 1]
      if (next === undefined)
        return Effect.fail({ kind: "flag" as const, line, detail: `actor: --${bare} requires a value` })
      flags[bare] = next
      i++
      continue
    }
    const eq = names.find((n) => a.startsWith(`--${n}=`))
    if (eq) {
      const v = a.slice(`--${eq}=`.length)
      if (v === "") return Effect.fail({ kind: "flag" as const, line, detail: `actor: --${eq} requires a value` })
      flags[eq] = v
      continue
    }
    rest.push(a)
  }
  return Effect.succeed({ flags, rest })
}

const mapActorVerb = Effect.fn("mapActorVerb")(function* (verb: string | undefined, args: string[], line: number) {
  switch (verb) {
    case "run": {
      const { flags, rest } = yield* extractNamedFlags(
        args,
        ["model", "task", "actor", "timeout", "command", "context", "output-schema"],
        line,
      )
      if (rest.length !== 3) return yield* actorArityError("run", '<subagent_type> "<description>" "<prompt>" [--model <ref>] [--task <TID>] [--actor <id>] [--timeout <ms>] [--command <cmd>] [--context none|state|full] [--output-schema <json>]', rest, line)
      return {
        operation: {
          action: "run" as const,
          subagent_type: rest[0],
          description: rest[1],
          prompt: rest[2],
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.task ? { task_id: flags.task } : {}),
          ...(flags.actor ? { actor_id: flags.actor } : {}),
          ...(flags.timeout ? { timeout_ms: Number(flags.timeout) } : {}),
          ...(flags.command ? { command: flags.command } : {}),
          ...(flags.context ? { context: flags.context } : {}),
          // JSON.parse throw surfaces as a parse-error for the whole script (parse
          // is all-or-nothing); bad enum/number flag values instead defer to zod at execute.
          ...(flags["output-schema"] ? { output_schema: JSON.parse(flags["output-schema"]) } : {}),
        },
      } as ActorShellArgs
    }
    case "spawn": {
      const { flags, rest } = yield* extractNamedFlags(
        args,
        ["model", "task", "actor", "command", "context", "output-schema"],
        line,
      )
      if (rest.length !== 3) return yield* actorArityError("spawn", '<subagent_type> "<description>" "<prompt>" [--model <ref>] [--task <TID>] [--actor <id>] [--command <cmd>] [--context none|state|full] [--output-schema <json>]', rest, line)
      return {
        operation: {
          action: "spawn" as const,
          subagent_type: rest[0],
          description: rest[1],
          prompt: rest[2],
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.task ? { task_id: flags.task } : {}),
          ...(flags.actor ? { actor_id: flags.actor } : {}),
          ...(flags.command ? { command: flags.command } : {}),
          ...(flags.context ? { context: flags.context } : {}),
          ...(flags["output-schema"] ? { output_schema: JSON.parse(flags["output-schema"]) } : {}),
        },
      } as ActorShellArgs
    }
    case "status":
      if (args.length !== 1) return yield* actorArityError("status", "<actor_id>", args, line)
      return { operation: { action: "status" as const, actor_id: args[0] } } as ActorShellArgs
    case "wait": {
      const { flags, rest } = yield* extractNamedFlags(args, ["timeout"], line)
      if (rest.length !== 1) return yield* actorArityError("wait", "<actor_id> [--timeout <ms>]", rest, line)
      return {
        operation: {
          action: "wait" as const,
          actor_id: rest[0],
          ...(flags.timeout ? { timeout_ms: Number(flags.timeout) } : {}),
        },
      } as ActorShellArgs
    }
    case "cancel":
      if (args.length !== 1) return yield* actorArityError("cancel", "<actor_id>", args, line)
      return { operation: { action: "cancel" as const, actor_id: args[0] } } as ActorShellArgs
    case "send": {
      const { flags, rest } = yield* extractNamedFlags(args, ["session", "type"], line)
      if (rest.length !== 2)
        return yield* actorArityError("send", '<to_actor_id> "<content>" [--session <id>] [--type <t>]', rest, line)
      return {
        operation: {
          action: "send" as const,
          to_actor_id: rest[0],
          content: rest[1],
          ...(flags.session ? { to_session_id: flags.session } : {}),
          ...(flags.type ? { type: flags.type } : {}),
        },
      } as ActorShellArgs
    }
    default: {
      const suggestion = suggestActorVerb(verb ?? "")
      const detail =
        `actor: unknown verb "${verb ?? ""}"\n` +
        `  available verbs: ${KNOWN_ACTOR_VERBS.join(", ")}` +
        (suggestion ? `\n  did you mean: ${suggestion}?` : "")
      return yield* Effect.fail({ kind: "unknown-verb", line, detail })
    }
  }
})

export function parseActorScript(
  script: string,
): Effect.Effect<ActorShellArgs[], unknown> {
  return Effect.gen(function* () {
    const argvList = yield* tokenize(script)
    const out: ActorShellArgs[] = []
    for (const argv of argvList) {
      const [head, verb, ...rest] = argv.tokens
      if (head !== "actor") {
        return yield* Effect.fail({
          kind: "unknown-verb",
          line: argv.line,
          detail: `actor: every command must start with 'actor' (got '${head ?? ""}')`,
        })
      }
      const parsed = yield* mapActorVerb(verb, rest, argv.line)
      out.push(parsed)
    }
    return out
  })
}

function inferAction(o: Record<string, unknown>): "run" | "spawn" {
  if (o.action === "spawn" || o.action === "run") return o.action
  if (o.background === true || o.async === true) return "spawn"
  return "run"
}

// Recover a shell-mode actor call that arrived shaped like the JSON tool args
// (no `script`): the Task-prior bare `{subagent_type, description, prompt}`, a
// stringified `{operation:"..."}` envelope, or an already-nested `{operation:{}}`.
// Returns the parsed shape for shellWrap to route to execute (which zod-validates
// it), or undefined if rawArgs can't be lifted.
export function recoverActorArgs(rawArgs: unknown): ActorShellArgs | undefined {
  if (rawArgs == null || typeof rawArgs !== "object") return undefined
  let obj = rawArgs as Record<string, unknown>
  if (typeof obj.operation === "string") {
    try {
      const inner = JSON.parse(obj.operation)
      if (inner && typeof inner === "object" && !Array.isArray(inner)) obj = { operation: inner }
    } catch {}
  }
  if (obj.operation && typeof obj.operation === "object" && !Array.isArray(obj.operation))
    return { operation: obj.operation } as ActorShellArgs
  const subagent_type = obj.subagent_type
  const description = obj.description
  const prompt = obj.prompt
  if (typeof subagent_type === "string" && typeof description === "string" && typeof prompt === "string") {
    const op: Record<string, unknown> = { action: inferAction(obj), subagent_type, description, prompt }
    // Carry only the optional fields a confused model plausibly puts at top level
    // alongside the bare Task-prior triple. This is a deliberate subset of the
    // run/spawn schema's optionals (model, actor_id, timeout_ms, command, context,
    // task_id, output_schema) — the others (timeout_ms/command/context/output_schema)
    // are dropped here, falling back to their schema defaults. Low risk in practice:
    // the bare shape mimo emits is the 3 required fields, rarely with extras. When
    // adding an actor schema field, decide whether bare-shape recover should carry
    // it here, or this whitelist silently drifts from the schema.
    if (typeof obj.model === "string") op.model = obj.model
    if (typeof obj.task_id === "string") op.task_id = obj.task_id
    if (typeof obj.actor_id === "string") op.actor_id = obj.actor_id
    return { operation: op } as ActorShellArgs
  }
  return undefined
}

export const ActorTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const actorRegistry = yield* ActorRegistry.Service
    const checkpoint = yield* SessionCheckpoint.Service
    const waiter = yield* ActorWaiter.Service
    const taskRegistry = yield* TaskRegistry.Service

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
            "Actor service unavailable — Actor.defaultLayer must be running for the actor tool to spawn or cancel actors",
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
        action: z.literal("run").describe("Spawn a subagent and block until it completes; the result is returned inline as the tool response."),
        description: z.string().min(1).describe("A short (3-5 words) description of the task."),
        prompt: z.string().min(1).describe("The task for the agent to perform."),
        subagent_type: subagentTypeEnum.describe("The type of specialized agent to use for this task."),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(MODEL_PARAM_DESCRIPTION),
        actor_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(optional) If set, resume the specified prior actor session instead of creating a new one. Distinct from the user-task IDs (T1, T2, ...) used by the `task` tool.",
          ),
        timeout_ms: timeoutField,
        command: z.string().min(1).optional().describe("(optional) The command that triggered this task."),
        context: z
          .enum(["none", "state", "full"])
          .optional()
          .describe(
            "(optional) Context inheritance. 'none' (default): child sees only prompt. 'full': child sees parent conversation (prefix cache sharing). 'state': child gets checkpoint summary.",
          ),
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
        action: z.literal("spawn").describe("Spawn a subagent and return its actor_id immediately; result is delivered as a notification or via a separate `wait` call."),
        description: z.string().min(1).describe("A short (3-5 words) description of the task."),
        prompt: z.string().min(1).describe("The task for the agent to perform."),
        subagent_type: subagentTypeEnum.describe("The type of specialized agent to use for this task."),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(MODEL_PARAM_DESCRIPTION),
        actor_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(optional) If set, resume the specified prior actor session instead of creating a new one.",
          ),
        command: z.string().min(1).optional().describe("(optional) The command that triggered this task."),
        context: z
          .enum(["none", "state", "full"])
          .optional()
          .describe("(optional) Context inheritance. Default 'none'."),
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
            runSchema,
            spawnSchema,
            statusSchema,
            waitSchema,
            cancelSchema,
            sendSchema,
          ])
          .meta({ type: "object" }),
      })

      const run = Effect.fn("ActorTool.execute")(function* (input: z.infer<typeof parameters>, ctx: Tool.Context) {
        const op = input.operation
        const cfg = yield* config.get()

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
          const entry = found.entry
          const snapshot = {
            status: entry.status,
            actor_id: entry.actorID,
            description: entry.description,
            agent: entry.agent,
            background: entry.background,
            turnCount: entry.turnCount,
            lastTurnTime: entry.lastTurnTime,
            ...(entry.lastError !== undefined ? { error: entry.lastError } : {}),
            time: entry.time,
          }
          return {
            title: `Actor status: ${entry.status}`,
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
          return {
            title: `Actor wait: ${snap.status}${snap.lastOutcome ? "/" + snap.lastOutcome : ""}`,
            output: JSON.stringify(snap),
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

        // op.action ==="run" or "spawn" — schema guarantees
        // description / prompt / subagent_type are present and non-empty.
        if (!ctx.extra?.bypassAgentCheck) {
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

        let prompt = op.prompt
        const background = op.action ==="spawn"

        // Inject checkpoint summaries for context="state" mode
        if (op.context === "state") {
          const latest = yield* checkpoint
            .loadLatest(ctx.sessionID)
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (latest) {
            prompt =
              [
                "<session-state>",
                "Here is a summary of the parent session's progress:",
                "",
                latest,
                "</session-state>",
                "",
              ].join("\n") + prompt
          }
          // If no checkpoint, fall through — child gets just the prompt (same as "none")
        }

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
            const existing = yield* taskRegistry.get({ session_id: ctx.sessionID, id: op.task_id })
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
        const spawnResult = yield* actor.spawn({
          mode: "subagent",
          sessionID: ctx.sessionID,
          agentType: next.name,
          description: op.description,
          task: prompt,
          context: op.context ?? "none",
          tools: next.toolAllowlist ? [...next.toolAllowlist] : "INHERIT",
          model,
          background,
          task_id: effectiveTaskId,
          ...(op.output_schema
            ? { format: { type: "json_schema" as const, schema: op.output_schema, retryCount: 2 } }
            : {}),
        })

        yield* ctx.metadata({
          title: op.description,
          metadata: {
            sessionId: spawnResult.sessionID,
            actorId: spawnResult.actorID,
            model,
          },
        })

        if (op.action ==="spawn") {
          return {
            title: op.description,
            metadata: { sessionId: spawnResult.sessionID, actorId: spawnResult.actorID, model },
            output:
              (taskNotice ? taskNotice + "\n" : "") +
              `Background actor started. actor_id: ${spawnResult.actorID}\nThe result will be delivered as a notification when complete.`,
          }
        }

        // op.action ==="run": blocking path — await the authoritative
        // `outcome` Deferred. It is resolved in spawn's onSuccess AFTER the
        // preStop loop AND the completion gate (but before the fire-and-forget
        // postStop loop), so the parent sees the reconciled status/summary —
        // unlike ActorWaiter, which resolves on the row's first `idle` and would
        // miss the gate's downgrade.
        function cancelHandler() {
          Effect.runFork(actor.cancel(spawnResult.sessionID, spawnResult.actorID, "graceful"))
        }
        const outcome = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            ctx.abort.addEventListener("abort", cancelHandler)
          }),
          () =>
            Deferred.await(spawnResult.outcome).pipe(
              Effect.timeout(op.timeout_ms ?? 600_000),
              Effect.catchTag("TimeoutError", () => Effect.succeed({ status: "timeout" as const })),
            ),
          () =>
            Effect.sync(() => {
              ctx.abort.removeEventListener("abort", cancelHandler)
            }),
        )

        // Blocking run preserves the pre-unification contract: tool call fails
        // when the child fails. The LLM sees a tool error, not a "success with
        // error in output." (The explicit action="wait" returns the structured
        // snapshot as a regular tool result — that's a different contract.)
        if (outcome.status === "failure") {
          return yield* Effect.fail(new Error(`Tool execution failed: ${outcome.error ?? "unknown"}`))
        }

        const resultText =
          outcome.status === "success"
            ? outcome.structured !== undefined
              ? JSON.stringify(outcome.structured)
              : (outcome.finalText ?? "(no output)")
            : outcome.status === "timeout"
              ? "<timeout>task did not complete within timeout</timeout>"
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
            `actor_id: ${spawnResult.actorID} (for resuming to continue this task if needed)`,
            "",
            `<actor_result status="${statusAttr}"${summaryAttr}>`,
            resultText,
            "</actor_result>",
          ].join("\n"),
        }
      })

      return {
        description: DESCRIPTION,
        parameters,
        execute: (input: z.infer<typeof parameters>, ctx: Tool.Context) => run(input, ctx).pipe(Effect.orDie),
        shell: {
          description: SHELL_DESCRIPTION,
          parse: parseActorScript,
          recover: recoverActorArgs,
        },
      }
    })
  }),
)
