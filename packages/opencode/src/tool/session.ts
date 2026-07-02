import * as Tool from "./tool"
import DESCRIPTION from "./session.txt"
import SHELL_DESCRIPTION from "./session.shell.txt"
import { tokenize } from "./shell-tokenize"
import z from "zod"
import { Effect, Deferred } from "effect"
import { Session } from "@/session"
import { Worktree } from "@/worktree"
import { Instance } from "@/project/instance"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect"
import { ActorRegistry } from "@/actor/registry"
import { Provider } from "@/provider"
import { spawnRef } from "@/actor/spawn-ref"
import { prefixCaptureRef } from "@/session/prefix-capture-ref"
import type { ForkContext, Interface as ActorInterface } from "@/actor/spawn"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import type { SessionID, MessageID } from "../session/schema"
import type { ProviderID, ModelID } from "../provider/schema"

const KNOWN_VERBS = ["create", "switch", "list", "cancel", "ask"]

// Wraps the human/agent question in a side-boundary system-reminder mirroring
// CC /btw + Codex side-question semantics: one-shot, READ-ONLY, answer-to-caller.
// The hard read-only guarantee comes from the tool whitelist at spawn (only
// read/grep/glob); this prompt reinforces it and forbids continuing the task.
function SIDE_QUESTION_PROMPT(question: string): string {
  return [
    "<system-reminder>",
    "This is a SIDE QUESTION about the session above (a frozen snapshot of its history).",
    "Answer it in a single response from that frozen context.",
    "You MAY use read-only tools (read/grep/glob) to inspect files, but you MUST NOT",
    "modify any file, run any command, or change any state. Do NOT continue, resume, or",
    "execute the session's underlying task — just answer the question, then stop.",
    "</system-reminder>",
    "",
    question,
  ].join("\n")
}

// One-shot, READ-ONLY fork-query: ask a (possibly running) target session a
// side question over a FROZEN snapshot of its history without disturbing its
// turn, and return the answer text. Mechanism mirrors tryStartCheckpointWriter
// (checkpoint.ts): capture the target's prefix at its watermark into a frozen
// ForkContext, spawn an ephemeral subagent over it with read-only tools,
// BLOCK on the outcome, return finalText. Non-interrupting: the fork runs in
// its own child session/actor over a frozen prefix; the target's own messages
// and actor are untouched.
export function forkQuery(deps: {
  sessions: Session.Interface
  provider: Provider.Interface
  actor: ActorInterface
}, targetSessionID: SessionID, question: string) {
  return Effect.gen(function* () {
    // a. Read the target's main slice + compute the watermark boundary.
    const msgs = yield* deps.sessions.messages({ sessionID: targetSessionID, agentID: "main" })
    const watermark = yield* deps.sessions.lastMainMessageID(targetSessionID)
    // Graceful: a target with no main-slice history (or no user message) can't
    // be snapshotted — buildPrefix needs a user message and there is nothing to
    // ask about. Answer directly instead of spawning.
    const hasUserMessage = msgs.some((m) => m.info.role === "user")
    if (!watermark || msgs.length === 0 || !hasUserMessage)
      return `(session ${targetSessionID} has no activity yet — nothing to ask about.)`

    // b. agentName for the prefix: the target's last assistant agent identity,
    // falling back to "build". Only affects the captured system-prompt baseline;
    // tools are OVERRIDDEN to read-only at spawn regardless.
    const lastAssistant = msgs.findLast((m) => m.info.role === "assistant")
    const agentName = (lastAssistant?.info as { agent?: string } | undefined)?.agent ?? "build"

    // Model for the prefix + the fork's LLM call: the project default. The prefix
    // captor needs a concrete provider/model; the answer quality is the default's.
    const model = yield* deps.provider.defaultModel()
    const providerID = model.providerID as ProviderID
    const modelID = model.modelID as ModelID

    // c. Build the frozen ForkContext via the late-bound prefix captor. If the
    // ref is unset (SessionPrompt.layer not running) we can't snapshot — degrade
    // gracefully rather than spawn a fork that would fail its runLoop.
    const buildPrefix = prefixCaptureRef.current
    if (!buildPrefix) return "(fork-query unavailable: prefix capture not initialized)"
    const prefix = yield* buildPrefix({
      sessionID: targetSessionID,
      agentName,
      providerID,
      modelID,
      msgs,
    })
    const forkCtx = {
      system: prefix.system,
      tools: prefix.tools,
      inheritedMessages: prefix.inheritedMessages,
      parentPermission: prefix.parentPermission,
      watermarkMsgID: watermark as MessageID,
      model: { providerID, modelID },
    } satisfies ForkContext

    // d. Ephemeral child session under the target hosts the query actor (like
    // checkpoint-writer). Parented to the target keeps it discoverable/cleanable.
    const childSession = yield* deps.sessions.create({
      parentID: targetSessionID,
      title: `ask: ${question.slice(0, 40)}`,
    })

    // e. Spawn BLOCKING + READ-ONLY. The tools whitelist (read/grep/glob) is the
    // HARD read-only guarantee: prompt.ts rejects any tool not in this list, so
    // write/edit/bash/patch are unavailable to the fork. background:false so we
    // await the answer; lifecycle:"ephemeral" so the host session is disposable.
    const result = yield* deps.actor.spawn({
      mode: "subagent",
      sessionID: childSession.id,
      parentSessionID: targetSessionID,
      agentType: agentName,
      description: "fork-query",
      task: SIDE_QUESTION_PROMPT(question),
      context: "full",
      tools: ["read", "grep", "glob"],
      model: { providerID, modelID },
      background: false,
      lifecycle: "ephemeral",
      forkContext: forkCtx,
    })
    const outcome = yield* Deferred.await(result.outcome)
    if (outcome.status === "success") return outcome.finalText ?? "(no answer)"
    const reason = outcome.status === "failure" ? outcome.error : outcome.status
    return `(fork-query failed: ${reason})`
  })
}

function levenshtein(a: string, b: string): number {
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

function suggestVerb(input: string): string | undefined {
  const candidates = KNOWN_VERBS.map((v) => ({ v, d: levenshtein(input, v) })).filter((c) => c.d <= 2)
  if (candidates.length !== 1) return undefined
  return candidates[0].v
}

const id = "session"

const createOperation = z.strictObject({
  action: z.literal("create"),
  task: z.string().min(1).describe("The task/prompt for the child session's first turn."),
  mode: z
    .enum(["build", "plan", "compose"])
    .optional()
    .describe(
      "Agent mode for the child session (build|plan|compose). Default build. Use compose for work needing planning (preferred); plan is a secondary planning-only mode.",
    ),
  model: z.string().min(1).optional().describe("Model group/tier name or literal provider/model for the child."),
  title: z.string().min(1).optional().describe("Title for the child session. Defaults to the task prefix."),
  dir: z.string().min(1).optional().describe("Working directory the child runs in (any project or path). Defaults to the orchestrator's directory."),
  isolate: z.boolean().optional().describe("Run the child in its own git worktree of `dir` (concurrent-edit isolation). Non-git dir falls back to shared."),
})

const switchOperation = z.strictObject({
  action: z.literal("switch"),
  sessionID: z.string().min(1).describe("Session id to move the user's frontend panel to."),
})

const listOperation = z.strictObject({
  action: z.literal("list"),
})

const cancelOperation = z.strictObject({
  action: z.literal("cancel"),
  sessionID: z.string().min(1).describe("Session id of the child session to stop."),
})

const askOperation = z.strictObject({
  action: z.literal("ask"),
  session_id: z.string().min(1).describe("Session id to ask a one-shot read-only side question."),
  question: z.string().min(1).describe("The side question to answer from a frozen snapshot of that session's history."),
})

const parameters = z.strictObject({
  // .meta({ type: "object" }) is REQUIRED — without it, the emitted JSON
  // schema's `operation` node has only `anyOf`, no `type`. Some models
  // (notably mimo-v2.5-pro) then stringify the entire envelope, producing
  // {"operation":"{\"action\":\"create\",...}"} which fails zod validation.
  // See research-tool-call-schema/REPORT.md §2.5 "success-nested" warning.
  operation: z
    .discriminatedUnion("action", [createOperation, switchOperation, listOperation, cancelOperation, askOperation])
    .meta({ type: "object" }),
})

type SessionInput = z.infer<typeof parameters>
type SessionOperation = SessionInput

type Metadata = {
  sessionID?: string
}

type Deps = Session.Service | ActorRegistry.Service | Provider.Service | Worktree.Service

function parseSessionScript(script: string): Effect.Effect<SessionOperation[], unknown> {
  return Effect.gen(function* () {
    const argvList = yield* tokenize(script)
    const out: SessionOperation[] = []
    for (const argv of argvList) {
      const [head, verb, ...rest] = argv.tokens
      if (head !== "session") {
        return yield* Effect.fail({
          kind: "unknown-verb",
          line: argv.line,
          detail: `session: every command must start with 'session' (got '${head ?? ""}')`,
        })
      }
      const parsed = yield* mapVerb(verb, rest, argv.line)
      out.push(parsed)
    }
    return out
  })
}

// Recover a shell-mode session call shaped like the JSON args (no `script`):
// a stringified/nested `operation`, or the common bare `{task}` create.
// Conservative — only the unambiguous create-from-task is synthesized; anything
// else passes through (nested) or returns undefined (→ teach JSON). Mirrors
// recoverTaskArgs in tool/task.ts.
export function recoverSessionArgs(rawArgs: unknown): SessionOperation | undefined {
  if (rawArgs == null || typeof rawArgs !== "object") return undefined
  let obj = rawArgs as Record<string, unknown>
  if (typeof obj.operation === "string") {
    try {
      const inner = JSON.parse(obj.operation)
      if (inner && typeof inner === "object" && !Array.isArray(inner)) obj = { operation: inner }
    } catch {}
  }
  if (obj.operation && typeof obj.operation === "object" && !Array.isArray(obj.operation))
    return { operation: obj.operation } as SessionOperation
  if (typeof obj.task === "string") {
    const op: Record<string, unknown> = { action: "create", task: obj.task }
    if (obj.mode === "build" || obj.mode === "plan" || obj.mode === "compose") op.mode = obj.mode
    if (typeof obj.model === "string") op.model = obj.model
    if (typeof obj.title === "string") op.title = obj.title
    return { operation: op } as SessionOperation
  }
  return undefined
}

// Extract a fixed set of `--name value` / `--name=value` string flags from a
// verb's args, leaving positionals in `rest`. A value flag with no value
// (`--mode` at end, or `--mode=`) sets `error` rather than silently dropping —
// so a dangling flag never swallows a positional into a confusing arity error.
function extractSessionFlags(
  args: string[],
  valueFlags: string[],
  boolFlags: string[] = [],
): { flags: Record<string, string>; bools: Record<string, boolean>; rest: string[]; error?: string } {
  const rest: string[] = []
  const flags: Record<string, string> = {}
  const bools: Record<string, boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const boolName = boolFlags.find((n) => a === `--${n}`)
    if (boolName) {
      bools[boolName] = true
      continue
    }
    const valName = valueFlags.find((n) => a === `--${n}`)
    if (valName) {
      const next = args[i + 1]
      if (next === undefined) return { flags, bools, rest, error: `--${valName} requires a value` }
      flags[valName] = next
      i++
      continue
    }
    const eq = valueFlags.find((n) => a.startsWith(`--${n}=`))
    if (eq) {
      const v = a.slice(`--${eq}=`.length)
      if (v === "") return { flags, bools, rest, error: `--${eq} requires a value` }
      flags[eq] = v
      continue
    }
    rest.push(a)
  }
  return { flags, bools, rest }
}

function flagError(verb: string, detail: string, line: number) {
  return Effect.fail({ kind: "flag", line, detail: `session: ${verb}: ${detail}` })
}

function arityError(verb: string, expected: string, args: string[], line: number) {
  return Effect.fail({
    kind: "arity",
    line,
    detail: `session: ${verb}: arity mismatch\n  got:      session ${verb} ${args.join(" ")}\n  expected: session ${verb} ${expected}`,
  })
}

function mapVerb(verb: string | undefined, args: string[], line: number): Effect.Effect<SessionOperation, unknown> {
  switch (verb) {
    case "create": {
      const { flags, bools, rest, error } = extractSessionFlags(args, ["mode", "model", "title", "dir"], ["isolate"])
      if (error) return flagError("create", error, line)
      if (rest.length < 1)
        return arityError("create", "<task...> [--mode build|plan|compose] [--model <ref>] [--title <t>] [--dir <path>] [--isolate]", rest, line)
      if (flags.mode && flags.mode !== "build" && flags.mode !== "plan" && flags.mode !== "compose")
        return flagError("create", `--mode must be build, plan or compose (got '${flags.mode}')`, line)
      return Effect.succeed({
        operation: {
          action: "create" as const,
          task: rest.join(" "),
          ...(flags.mode ? { mode: flags.mode as "build" | "plan" | "compose" } : {}),
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.title ? { title: flags.title } : {}),
          ...(flags.dir ? { dir: flags.dir } : {}),
          ...(bools.isolate ? { isolate: true } : {}),
        },
      })
    }
    case "switch": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("switch", error, line)
      if (rest.length !== 1) return arityError("switch", "<sessionID>", rest, line)
      return Effect.succeed({ operation: { action: "switch" as const, sessionID: rest[0] } })
    }
    case "list": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("list", error, line)
      if (rest.length !== 0) return arityError("list", "", rest, line)
      return Effect.succeed({ operation: { action: "list" as const } })
    }
    case "cancel": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("cancel", error, line)
      if (rest.length !== 1) return arityError("cancel", "<sessionID>", rest, line)
      return Effect.succeed({ operation: { action: "cancel" as const, sessionID: rest[0] } })
    }
    case "ask": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("ask", error, line)
      if (rest.length < 2) return arityError("ask", "<sessionID> <question...>", rest, line)
      return Effect.succeed({
        operation: { action: "ask" as const, session_id: rest[0], question: rest.slice(1).join(" ") },
      })
    }
    default: {
      const suggestion = suggestVerb(verb ?? "")
      const detail =
        `session: unknown verb "${verb ?? ""}"\n` +
        `  available verbs: ${KNOWN_VERBS.join(", ")}` +
        (suggestion ? `\n  did you mean: ${suggestion}?` : "")
      return Effect.fail({ kind: "unknown-verb", line, detail })
    }
  }
}

export const SessionTool = Tool.define<typeof parameters, Metadata, Deps>(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const actorReg = yield* ActorRegistry.Service
    const provider = yield* Provider.Service
    const worktreeSvc = yield* Worktree.Service

    // Resolve the Actor service through the late-bound spawnRef rather than as a
    // Layer dependency: pulling Actor.Service into Deps would create a layer
    // cycle (Actor → SessionPrompt → ToolRegistry → tool/session → Actor) that
    // Effect cannot satisfy. The ref is populated by Actor.layer's initialiser
    // (see actor/spawn-ref.ts). Same pattern as tool/actor.ts.
    const requireActor = () => {
      const a = spawnRef.current
      if (!a) {
        return Effect.fail(
          new Error(
            "Actor service unavailable — Actor.defaultLayer must be running for the session tool to spawn or cancel sessions",
          ),
        )
      }
      return Effect.succeed(a)
    }

    const run = Effect.fn("SessionTool.execute")(function* (input: SessionInput, ctx: Tool.Context<Metadata>) {
      const op = input.operation

      if (op.action === "create") {
        const actor = yield* requireActor()
        const model = op.model
          ? yield* provider
              .resolveModelRef(op.model, undefined)
              .pipe(Effect.map((m) => ({ modelID: m.id, providerID: m.providerID })))
          : undefined

        // `--dir` is where the child runs (any project/path); default is the
        // orchestrator's own directory. `--isolate` additionally runs it in its
        // own git worktree OF THAT dir's repo.
        const targetDir = op.dir ?? (yield* InstanceState.directory)

        let effectiveDir = targetDir
        let isolateNotice = ""
        if (op.isolate) {
          // LOAD-BEARING: Worktree.create resolves against the AMBIENT Instance
          // (InstanceState.context = (yield* InstanceRef) ?? Instance.current).
          // To worktree a DIFFERENT dir's repo we must run it under THAT dir's
          // Instance. Boot/cache that dir's InstanceContext (Instance.provide
          // returns a Promise; the worktree call is an Effect), then provide it
          // as InstanceRef — sufficient because makeWorktreeInfo/setup read only
          // InstanceState.context. NotGitError is a synchronous throw inside an
          // Effect.fn (a DEFECT, not a typed failure), so Effect.catch can't see
          // it; Effect.exit captures any non-success (failure OR defect) and we
          // degrade to shared — never fail the create.
          const ctxResult = yield* Effect.exit(
            Effect.promise(() => Instance.provide({ directory: targetDir, fn: () => Instance.current })),
          )
          const wtDir = ctxResult._tag === "Success"
            ? yield* worktreeSvc
                .create({ name: op.title ?? op.task.slice(0, 40) })
                .pipe(
                  Effect.provideService(InstanceRef, ctxResult.value),
                  Effect.exit,
                  Effect.map((exit) => (exit._tag === "Success" ? exit.value.directory : undefined)),
                )
            : undefined
          if (wtDir) effectiveDir = wtDir
          else
            isolateNotice =
              " (note: --isolate ignored — directory is not a git repo or worktree creation failed; running shared)"
        }

        const result = yield* actor.spawn({
          mode: "peer",
          sessionID: ctx.sessionID as SessionID,
          agentType: op.mode ?? "build",
          task: op.task,
          description: op.title ?? op.task.slice(0, 40),
          context: "none",
          tools: "INHERIT",
          ...(model ? { model } : {}),
          background: true,
          parentActorID: ctx.actorID,
          lifecycle: "persistent",
          cwd: effectiveDir,
        })
        // spawnPeer titles the child session `${agentType}: ${task}`; honor an
        // explicit --title by overwriting it so `session list` shows what the
        // orchestrator asked for.
        if (op.title) yield* sessions.setTitle({ sessionID: result.sessionID, title: op.title })
        return {
          title: `Session created: ${result.sessionID}`,
          output:
            `Created child session ${result.sessionID} (mode: ${op.mode ?? "build"}) in ${effectiveDir}.` +
            (op.isolate && !isolateNotice ? ` Isolated in its own worktree.` : isolateNotice) +
            ` Running in the background.`,
          metadata: { sessionID: result.sessionID } as Metadata,
        }
      }

      if (op.action === "switch") {
        yield* Effect.promise(() => Bus.publish(TuiEvent.SessionSelect, { sessionID: op.sessionID as SessionID }))
        return {
          title: `Switched to ${op.sessionID}`,
          output: `Requested the UI navigate to session ${op.sessionID}.`,
          metadata: { sessionID: op.sessionID } as Metadata,
        }
      }

      if (op.action === "list") {
        // Peers register with session_id === their own child.id (see
        // Actor.spawnPeer / the create branch above), so listByParent —
        // which filters on session_id === orchestrator id — never matches
        // them. The reliable parent link is the Session row's parentID, set
        // to ctx.sessionID at create time. Enrich each child with its actor
        // row (mode/agent/status) keyed by sessionID === actorID === child.id.
        const children = yield* sessions.children(ctx.sessionID as SessionID)
        if (children.length === 0)
          return { title: "Child sessions: 0", output: "No child sessions.", metadata: {} as Metadata }
        const lines = yield* Effect.forEach(children, (child) =>
          actorReg.get(child.id, child.id).pipe(
            Effect.map((actor) =>
              `${child.id} — ${child.title} — ${actor?.agent ?? "?"} — ${actor?.status ?? "unknown"}`,
            ),
          ),
        )
        return { title: `Child sessions: ${children.length}`, output: lines.join("\n"), metadata: {} as Metadata }
      }

      if (op.action === "cancel") {
        const actor = yield* requireActor()
        yield* actor.cancel(op.sessionID as SessionID, op.sessionID, "graceful")
        // Remove the child's worktree in ITS OWN project's Instance: a child may
        // live in a worktree of a DIFFERENT project than us, and Worktree.remove's
        // `git worktree remove` resolves against the ambient Instance. Resolve the
        // child dir's InstanceContext and provide it as InstanceRef. Worktree.remove
        // is a no-op for a non-worktree dir, so shared-dir children are safe.
        // Best-effort throughout (Effect.exit): never fail the cancel. The
        // orchestrator only cancels once a child's work is merged or abandoned
        // (prompt rule), so this never discards live work.
        const child = yield* sessions.get(op.sessionID as SessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        let removed = false
        if (child) {
          const ctxExit = yield* Effect.exit(
            Effect.promise(() => Instance.provide({ directory: child.directory, fn: () => Instance.current })),
          )
          if (ctxExit._tag === "Success") {
            const remExit = yield* worktreeSvc
              .remove({ directory: child.directory })
              .pipe(Effect.provideService(InstanceRef, ctxExit.value), Effect.exit)
            removed = remExit._tag === "Success" ? remExit.value : false
          }
        }
        return {
          title: `Cancelled ${op.sessionID}`,
          output:
            `Requested cancellation of session ${op.sessionID}.` +
            (removed ? ` Removed its worktree (branch deleted).` : ``),
          metadata: { sessionID: op.sessionID } as Metadata,
        }
      }

      if (op.action === "ask") {
        const actor = yield* requireActor()
        const answer = yield* forkQuery({ sessions, provider, actor }, op.session_id as SessionID, op.question)
        return {
          title: `Asked ${op.session_id}`,
          output: answer,
          metadata: { sessionID: op.session_id } as Metadata,
        }
      }

      // Exhaustive: every action in the discriminated union is handled above,
      // so `op` is `never` here. This guards against a future verb being added
      // to the union without a matching branch.
      return yield* Effect.fail(new Error(`session: unhandled verb ${JSON.stringify(op)}`))
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (args: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) => run(args, ctx).pipe(Effect.orDie),
      shell: {
        description: SHELL_DESCRIPTION,
        parse: parseSessionScript,
        recover: recoverSessionArgs,
      },
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
