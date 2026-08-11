import * as Tool from "./tool"
import { realpathSync } from "fs"
import path from "path"
import DESCRIPTION from "./session.txt"
import SHELL_DESCRIPTION from "./session.shell.txt"
import { tokenize } from "./shell-tokenize"
import z from "zod"
import { Cause, Effect, Deferred } from "effect"
import { Session } from "@/session"
import { classifySession, classifyUnreadableActors } from "@/session/visibility"
import { Worktree } from "@/worktree"
import { Instance } from "@/project/instance"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect"
import { ActorRegistry } from "@/actor/registry"
import { deriveLiveness } from "@/actor/schema"
import { joinGroup } from "@/actor/group"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"
import { forwardRef } from "@/permission/permission-forward-ref"
import { Provider } from "@/provider"
import { spawnRef } from "@/actor/spawn-ref"
import { inboxServiceRef } from "@/inbox/inbox-ref"
import { prefixCaptureRef } from "@/session/prefix-capture-ref"
import type { ForkContext, Interface as ActorInterface } from "@/actor/spawn"
import { Bus } from "@/bus"
import { Git } from "@/git"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { assembleFleet, renderFleetTable } from "./fleet"
import type { FleetActorInput, WorktreeEntry } from "./fleet"
import type { SessionID, MessageID } from "../session/schema"
import type { ProviderID, ModelID } from "../provider/schema"

const KNOWN_VERBS = ["create", "send", "switch", "list", "dashboard", "status", "cancel", "ask", "join", "setmode", "approve", "grant-approval"]

// Wraps the human/agent question in a side-boundary system-reminder:
// one-shot, READ-ONLY, answer-to-caller.
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
}, targetSessionID: SessionID, question: string, selectedModel?: { providerID: ProviderID; modelID: ModelID }) {
  return Effect.gen(function* () {
    // a. Resolve the target's persisted history and the slice to snapshot.
    // A child created via `session create` runs as a PEER actor whose actorID
    // === its own sessionID, so SessionPrompt persists its turns under
    // agent_id = <targetSessionID> — NOT "main". Reading only the "main" slice
    // (the old behaviour) therefore saw an empty history for every peer child
    // (isolated or idle alike) and reported "no activity" even after real turns.
    // Read ALL slices, then pick the slice that actually holds the child's
    // conversation: "main" for an orchestrator/main session, else the peer's
    // own-session slice. This answers from FROZEN persisted history regardless
    // of whether the child is still running, went idle, or was isolated.
    const all = yield* deps.sessions.messages({ sessionID: targetSessionID, agentID: "*" })
    const sliceOf = (agentID: string) =>
      all.filter((m) => (m.info.agentID ?? "main") === agentID)
    const mainSlice = sliceOf("main")
    // Prefer "main" when it carries real activity; otherwise fall back to the
    // peer child's own-session slice (agent_id === targetSessionID).
    const msgs = mainSlice.some((m) => m.info.role === "user") ? mainSlice : sliceOf(targetSessionID)
    const watermark = msgs.at(-1)?.info.id
    // Graceful: a target whose selected slice has no history (or no user
    // message) can't be snapshotted — buildPrefix needs a user message and
    // there is nothing to ask about. Answer directly instead of spawning.
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
    const model = selectedModel ?? (yield* deps.provider.defaultModel())
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

// --topic persistence: the topic label is stored as a machine-readable marker
// prefixed onto the child session's TITLE (`[topic:<label>] <title>`). The
// Session row already persists across restarts and is returned by
// sessions.children, so this needs no schema/migration — a deliberately thin
// surface. topicOf() reads a peer child's topic back for the reuse lookup;
// tagTitle() writes the marker at create time.
const TOPIC_MARKER = /^\[topic:([^\]]+)\]\s?/

function topicOf(title: string): string | undefined {
  const m = title.match(TOPIC_MARKER)
  return m ? m[1] : undefined
}

function tagTitle(topic: string, title: string): string {
  // Idempotent: never double-tag if the base title already carries a marker.
  const base = title.replace(TOPIC_MARKER, "")
  return `[topic:${topic}] ${base}`
}

// The topic label is a MODEL-authored free-text string, so exact-string matching
// makes find-or-reuse silently fail on the near-misses a model actually produces:
// `pr-1741` vs `PR 1741` vs `pr_1741` are one topic to a human and three to
// `===`, and each miss spawns a duplicate child for the same theme. Normalize to
// a case-folded alphanumeric-run key so those all collide. Deliberately NOT
// fuzzy/semantic: it only forgives casing and separators, so it cannot merge two
// genuinely different topics.
export function topicKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}


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
  topic: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Reuse a standing per-theme child: if a peer child already carries this topic, RELAY the task into it (enqueue+wake) instead of spawning; otherwise create a new child tagged with this topic. Avoids over-spawning sessions for the same theme.",
    ),
})

const sendOperation = z.strictObject({
  action: z.literal("send"),
  sessionID: z.string().min(1).describe("Child session id to relay a new task to (enqueues into its inbox and wakes it)."),
  task: z.string().min(1).describe("The task/message to relay. The idle-but-persistent child wakes and drains it as its next turn."),
})

const switchOperation = z.strictObject({
  action: z.literal("switch"),
  sessionID: z.string().min(1).describe("Session id to move the user's frontend panel to."),
})

const listOperation = z.strictObject({
  action: z.literal("list"),
})

const dashboardOperation = z.strictObject({
  action: z.literal("dashboard"),
})

const statusOperation = z.strictObject({
  action: z.literal("status"),
  sessionID: z.string().min(1).describe("Child session id to report derived liveness for (progressing/stalled/terminal + turn telemetry)."),
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

const joinOperation = z.strictObject({
  action: z.literal("join"),
  sessionIDs: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Child session ids forming the dispatch group. Blocks until ALL have reached a terminal state (success/fail/cancel), then returns one aggregated per-child summary.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Milliseconds to wait before returning a partial (timeout) aggregate. Default 600000 (10 min)."),
})

const setmodeOperation = z.strictObject({
  action: z.literal("setmode"),
  sessionID: z.string().min(1).describe("Session id of the child session whose mode to change."),
  mode: z
    .enum(["build", "plan", "compose"])
    .describe("New agent mode the child's SUBSEQUENT turns run under (build|plan|compose)."),
})

const approveOperation = z.strictObject({
  action: z.literal("approve"),
  sessionID: z.string().min(1).describe("Child session id whose pending permission request to approve."),
})

const grantApprovalOperation = z.strictObject({
  action: z.literal("grant-approval"),
  target: z
    .string()
    .min(1)
    .describe("A child session id to auto-approve future asks for, or 'all' to auto-approve every child."),
})

const parameters = z.strictObject({
  // .meta({ type: "object" }) is REQUIRED — without it, the emitted JSON
  // schema's `operation` node has only `anyOf`, no `type`. Some models
  // (notably mimo-v2.5-pro) then stringify the entire envelope, producing
  // {"operation":"{\"action\":\"create\",...}"} which fails zod validation.
  // See research-tool-call-schema/REPORT.md §2.5 "success-nested" warning.
  operation: z
    .discriminatedUnion("action", [createOperation, sendOperation, switchOperation, listOperation, dashboardOperation, statusOperation, cancelOperation, askOperation, joinOperation, setmodeOperation, approveOperation, grantApprovalOperation])
    .meta({ type: "object" }),
})

type SessionInput = z.infer<typeof parameters>
type SessionOperation = SessionInput

type Metadata = {
  sessionID?: string
}

type Deps = Session.Service | ActorRegistry.Service | Provider.Service | Worktree.Service | Bus.Service | Git.Service

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

// Fields that only make sense for an operation OTHER than `create` — they name
// an already-existing session (or an ask/grant target). Their presence is
// positive evidence the model meant to ROUTE, so recovery must never answer with
// a synthesized `create`: that would silently spawn a duplicate child instead of
// erroring, which is precisely the route-first violation #1741 exists to prevent
// (and it is invisible — no error, just an extra session).
const ROUTE_ONLY_FIELDS = ["sessionID", "session_id", "sessionIDs", "question", "target"]

// Recover a shell-mode session call shaped like the JSON args (no `script`):
// a stringified/nested `operation`, a FLATTENED `{operation|action, ...operands}`,
// or the common bare `{task}` create. Conservative — a `create` is synthesized
// only from an unambiguous bare `{task}` with no routing evidence; everything
// else either reconstructs the operation the model actually named or returns
// undefined (→ the call errors loudly and the model self-corrects). Mirrors
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
  // FLATTENED shape, repeatedly observed from mimo-v2.5:
  //   {"operation":"send","sessionID":"ses_…","task":"…"}
  // The discriminator sits at the TOP level — either as a bare `operation` verb
  // that survived the JSON.parse above, or as `action` — with the operands as its
  // siblings. Re-nest and validate against the real union so the model's actual
  // intent runs. Note shell-wrap hands a recovered value straight to
  // def.execute WITHOUT re-validating it, so validating here is what makes the
  // reconstruction safe; a shape that does not validate returns undefined and
  // surfaces as an "invalid arguments" error rather than being coerced.
  const action =
    typeof obj.action === "string" ? obj.action : typeof obj.operation === "string" ? obj.operation : undefined
  if (action !== undefined) {
    const operands = Object.fromEntries(Object.entries(obj).filter(([key]) => key !== "operation" && key !== "action"))
    const parsed = parameters.safeParse({ operation: { ...operands, action } })
    return parsed.success ? (parsed.data as SessionOperation) : undefined
  }
  if (typeof obj.task === "string" && !ROUTE_ONLY_FIELDS.some((field) => obj[field] !== undefined)) {
    const op: Record<string, unknown> = { action: "create", task: obj.task }
    if (obj.mode === "build" || obj.mode === "plan" || obj.mode === "compose") op.mode = obj.mode
    if (typeof obj.model === "string") op.model = obj.model
    if (typeof obj.title === "string") op.title = obj.title
    if (typeof obj.topic === "string") op.topic = obj.topic
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
      const { flags, bools, rest, error } = extractSessionFlags(args, ["mode", "model", "title", "dir", "topic"], ["isolate"])
      if (error) return flagError("create", error, line)
      if (rest.length < 1)
        return arityError("create", "<task...> [--mode build|plan|compose] [--model <ref>] [--title <t>] [--dir <path>] [--topic <label>] [--isolate]", rest, line)
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
          ...(flags.topic ? { topic: flags.topic } : {}),
          ...(bools.isolate ? { isolate: true } : {}),
        },
      })
    }
    case "send": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("send", error, line)
      if (rest.length < 2) return arityError("send", "<sessionID> <task...>", rest, line)
      return Effect.succeed({
        operation: { action: "send" as const, sessionID: rest[0], task: rest.slice(1).join(" ") },
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
    case "dashboard": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("dashboard", error, line)
      if (rest.length !== 0) return arityError("dashboard", "", rest, line)
      return Effect.succeed({ operation: { action: "dashboard" as const } })
    }
    case "status": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("status", error, line)
      if (rest.length !== 1) return arityError("status", "<sessionID>", rest, line)
      return Effect.succeed({ operation: { action: "status" as const, sessionID: rest[0] } })
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
    case "join": {
      const { flags, rest, error } = extractSessionFlags(args, ["timeout"])
      if (error) return flagError("join", error, line)
      if (rest.length < 1) return arityError("join", "<sessionID...> [--timeout <ms>]", rest, line)
      let timeout_ms: number | undefined
      if (flags.timeout !== undefined) {
        const n = Number(flags.timeout)
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n))
          return flagError("join", `--timeout must be a positive integer (got '${flags.timeout}')`, line)
        timeout_ms = n
      }
      return Effect.succeed({
        operation: {
          action: "join" as const,
          sessionIDs: rest,
          ...(timeout_ms !== undefined ? { timeout_ms } : {}),
        },
      })
    }
    case "setmode": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("setmode", error, line)
      if (rest.length !== 2) return arityError("setmode", "<sessionID> <build|plan|compose>", rest, line)
      if (rest[1] !== "build" && rest[1] !== "plan" && rest[1] !== "compose")
        return flagError("setmode", `mode must be build, plan or compose (got '${rest[1]}')`, line)
      return Effect.succeed({
        operation: { action: "setmode" as const, sessionID: rest[0], mode: rest[1] as "build" | "plan" | "compose" },
      })
    }
    case "approve": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("approve", error, line)
      if (rest.length !== 1) return arityError("approve", "<sessionID>", rest, line)
      return Effect.succeed({ operation: { action: "approve" as const, sessionID: rest[0] } })
    }
    case "grant-approval": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("grant-approval", error, line)
      if (rest.length !== 1) return arityError("grant-approval", "<sessionID|all>", rest, line)
      return Effect.succeed({ operation: { action: "grant-approval" as const, target: rest[0] } })
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

// Enumerate the worktrees of the orchestrator's repo and, per branch, its
// commits-ahead of the repo's default branch — the raw material assembleFleet
// correlates to isolated child sessions by directory. Reads git through the
// Git.Service (run + defaultBranch). `git worktree list --porcelain` emits
// stanzas ("worktree <path>", "branch refs/heads/<b>", "detached", blank line);
// we parse path + short branch, realpath-canonicalize the path so it matches a
// session.directory, and compute ahead via `rev-list --count <base>..<branch>`.
// Best-effort per entry: a failed rev-list leaves `ahead` undefined; a git
// failure at the list step propagates to the caller's catch (→ no correlation).
function collectWorktrees(git: Git.Interface, dir: string) {
  return Effect.gen(function* () {
    const list = yield* git.run(["worktree", "list", "--porcelain"], { cwd: dir })
    if (list.exitCode !== 0) return [] as WorktreeEntry[]

    const raw: { path: string; branch?: string }[] = []
    for (const line of list.text().split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("worktree ")) raw.push({ path: trimmed.slice("worktree ".length).trim() })
      else if (trimmed.startsWith("branch ")) {
        const current = raw[raw.length - 1]
        if (current) current.branch = trimmed.slice("branch ".length).trim().replace(/^refs\/heads\//, "")
      }
    }

    const base = yield* git.defaultBranch(dir).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const baseRef = base?.ref

    return yield* Effect.forEach(raw, (entry) =>
      Effect.gen(function* () {
        const directory = yield* Effect.sync(() => {
          try {
            return realpathSync(entry.path)
          } catch {
            return path.normalize(entry.path)
          }
        })
        let ahead: number | undefined
        if (baseRef && entry.branch) {
          const rev = yield* git
            .run(["rev-list", "--count", `${baseRef}..${entry.branch}`], { cwd: dir })
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (rev && rev.exitCode === 0) {
            const n = Number(rev.text().trim())
            if (Number.isFinite(n)) ahead = n
          }
        }
        return { directory, branch: entry.branch, ahead } satisfies WorktreeEntry
      }),
    )
  })
}

export const SessionTool = Tool.define<typeof parameters, Metadata, Deps>(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const actorReg = yield* ActorRegistry.Service
    const provider = yield* Provider.Service
    const worktreeSvc = yield* Worktree.Service
    const bus = yield* Bus.Service
    const git = yield* Git.Service

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
            "Actor service unavailable — Actor.appLayer must be running for the session tool to spawn or cancel sessions",
          ),
        )
      }
      return Effect.succeed(a)
    }

    // ROUTE-FIRST WITHIN ONE TURN. The system-prompt fleet roster is assembled
    // once per REQUEST, so a child dispatched earlier in the SAME turn is
    // invisible to the model until the next request — which is exactly how one
    // live turn spawned two children for the same docs topic and then had to
    // cancel one, burning a worktree. A tool RESULT, unlike the system prompt, is
    // read before the model's next tool call, so every DISPATCH (`create` AND
    // `send`) echoes the live sibling roster into its own output. That closes the
    // staleness hole with DATA (the ids needed to `session send`) rather than with
    // prompt wording, and without any mid-turn system-prompt rebuild.
    //
    // The child THIS call just dispatched to is INCLUDED and marked, with an
    // excerpt of the brief it was handed. The failure being fixed is
    // self-duplication — the model re-dispatching work it just sent — so listing
    // only the OTHER siblings hides precisely the row that makes the repeat
    // self-evident, and leaves the first dispatch of a turn with no ledger at all.
    // Making the duplicate VISIBLE is deliberate in place of refusing it: there is
    // no reliable semantic key for "same topic", and a false refusal would block
    // legitimate parallel fan-out — strictly worse than a duplicate the model can
    // see and correct.
    //
    // EXPOSURE. A tool result is MORE exposed than the system prompt, not less:
    // it arrives mid-turn as fresh content and a model may relay it as if it were
    // its own output — which is exactly how the system-prompt roster's
    // `<active-sessions>` envelope ended up on a user's screen (see ROSTER_HEADER
    // in session/llm.ts). This block was already safer in the way that mattered
    // there: it carries no XML tag for the model to imitate, only a prose lead-in
    // and indented rows. The added "internal working context" sentence is the
    // weak half of the same pair — it can only ask, and it does not stop a
    // paraphrase of a child's title. It is here because it costs one clause and
    // sits adjacent to the data it governs.
    const dispatchLedgerNotice = Effect.fn("SessionTool.dispatchLedger")(function* (
      parentID: SessionID,
      dispatched: { id: string; verb: string; task: string },
    ) {
      const children = yield* sessions.children(parentID)
      const enriched = yield* Effect.forEach(children, (child) =>
        actorReg.get(child.id, child.id).pipe(Effect.map((actor) => ({ child, actor }))),
      )
      const now = Date.now()
      // Same routability rule as the roster in session/llm.ts: real peers only,
      // dead (failed/cancelled) children excluded, success reported as idle. The
      // just-dispatched child is EXEMPT from the liveness filter — its line is a
      // fact about what this call did, not a judgement about the child's health,
      // so it must survive whatever deriveLiveness reports for a brand-new row.
      const lines = enriched
        .flatMap(({ child, actor }) => (actor ? [{ child, actor }] : []))
        .filter(({ actor }) => actor.mode !== "subagent" && !SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent))
        .map((e) => ({ ...e, live: deriveLiveness(e.actor, now) }))
        .filter(({ child, live }) => child.id === dispatched.id || (live !== "failure" && live !== "cancelled"))
        .map(
          ({ child, actor, live }) =>
            `  ${child.id} | ${child.title} | ${actor.agent} | ${live === "success" ? "idle" : live}` +
            (child.id === dispatched.id
              ? `   <-- YOU JUST ${dispatched.verb} THIS, IN THE CURRENT TURN: "${dispatched.task.replace(/\s+/g, " ").slice(0, 100)}"`
              : ``),
        )
      if (lines.length === 0) return ""
      return (
        `\n\nROUTE FIRST — these are your routable child sessions right now, including the one this call just ` +
        `dispatched to. Before you dispatch again in THIS turn, re-read this list: if the next piece of work ` +
        `belongs to one of these, use \`session send <id> <task>\` instead of \`session create\` — and do not ` +
        `re-send work that is already marked as just dispatched. This ledger is internal working ` +
        `context, not output — do not repeat it to the user, report what you routed:\n${lines.join("\n")}`
      )
    })

    const run = Effect.fn("SessionTool.execute")(function* (input: SessionInput, ctx: Tool.Context<Metadata>) {
      const op = input.operation

      if (op.action === "create") {
        const actor = yield* requireActor()

        // --topic find-or-reuse: before spawning, look for a standing peer child
        // already tagged with this topic. If found, RELAY the task into it
        // (enqueue+wake — the same idle-peer path `session send` uses) instead of
        // over-spawning a fresh child. Filter identical to the `list` branch:
        // real peers only (exclude subagents + system-spawned agents).
        if (op.topic) {
          const children = yield* sessions.children(ctx.sessionID as SessionID)
          const enriched = yield* Effect.forEach(children, (child) =>
            actorReg.get(child.id, child.id).pipe(Effect.map((a) => ({ child, actor: a }))),
          )
          const match = enriched.find(
            ({ child, actor: a }) => {
              if (a?.mode === "subagent") return false
              if (a && SYSTEM_SPAWNED_AGENT_TYPES.has(a.agent)) return false
              const existing = topicOf(child.title)
              // Normalized compare: `--topic "PR 1741"` must find the child
              // tagged `pr-1741`, otherwise find-or-reuse degrades to
              // find-or-duplicate on the first label the model retypes.
              return existing !== undefined && topicKey(existing) === topicKey(op.topic!)
            },
          )
          if (match) {
            const childID = match.child.id
            const inboxSvc = inboxServiceRef.current
            if (!inboxSvc) {
              return yield* Effect.fail(
                new Error("Inbox service unavailable — Inbox.defaultLayer must be running for the session tool to relay tasks"),
              )
            }
            const sendResult = yield* inboxSvc
              .send({
                receiverSessionID: childID,
                receiverActorID: childID,
                senderSessionID: ctx.sessionID as SessionID,
                senderActorID: ctx.actorID ?? "main",
                content: op.task,
              })
              .pipe(Effect.catchTag("InboxReceiverNotFound", () => Effect.succeed({ inboxID: null as string | null })))
            if (sendResult.inboxID !== null) {
              return {
                title: `Reused topic '${op.topic}' → relayed to ${childID}`,
                output:
                  `Found standing child ${childID} for topic '${op.topic}'. ` +
                  `Enqueued the task into it and woke it — it runs the relayed task as its next turn.` +
                  (yield* dispatchLedgerNotice(ctx.sessionID as SessionID, {
                    id: childID,
                    verb: "SENT THIS TASK TO",
                    task: op.task,
                  })),
                metadata: { sessionID: childID } as Metadata,
              }
            }
            // The tagged peer exists but isn't reachable yet (no receiver row).
            // Fall through to create a fresh tagged child rather than fail — the
            // topic still gets a standing child, just a new one.
          }
        }

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
        // orchestrator asked for. When --topic is set, prefix the title with a
        // `[topic:X]` marker so a later `create --topic X` finds and reuses this
        // standing child (topicOf reads it back from sessions.children).
        if (op.topic) {
          const base = op.title ?? `${op.mode ?? "build"}: ${op.task.slice(0, 40)}`
          yield* sessions.setTitle({ sessionID: result.sessionID, title: tagTitle(op.topic, base) })
        } else if (op.title) {
          yield* sessions.setTitle({ sessionID: result.sessionID, title: op.title })
        }
        const siblingNotice = yield* dispatchLedgerNotice(ctx.sessionID as SessionID, {
          id: result.sessionID,
          verb: "CREATED",
          task: op.task,
        })
        return {
          title: `Session created: ${result.sessionID}`,
          output:
            `Created child session ${result.sessionID} (mode: ${op.mode ?? "build"}) in ${effectiveDir}.` +
            (op.topic ? ` Tagged with topic '${op.topic}' for reuse.` : ``) +
            (op.isolate && !isolateNotice ? ` Isolated in its own worktree.` : isolateNotice) +
            ` Running in the background.` +
            siblingNotice,
          metadata: { sessionID: result.sessionID } as Metadata,
        }
      }

      if (op.action === "send") {
        // Relay a NEW task into a standing (persistent) child, waking it if idle.
        // A peer child registers with session_id === actor_id === its own child
        // id (see the create branch / Actor.spawnPeer), so both the receiver
        // session and actor id are the child session id. Inbox.send enqueues a
        // durable row and fork-schedules a wake; the woken runLoop drains it as
        // the child's next turn. Gap-A's drain seed-fallback ensures an idle /
        // turnCount-0 peer still converts the queued task into a turn instead of
        // idling back with the task stuck in the DB.
        const childID = op.sessionID as SessionID
        // Pre-check the child is actually a peer we manage; give a clear message
        // instead of a raw ESRCH if the id is wrong or the child never existed.
        const actor = yield* actorReg.get(childID, childID)
        if (!actor) {
          return {
            title: `Send failed: ${op.sessionID} not found`,
            output:
              `No child session ${op.sessionID} is registered. Use \`session list\` to see your children, ` +
              `or \`session create\` to start a new one.`,
            metadata: { sessionID: op.sessionID } as Metadata,
          }
        }
        const inboxSvc = inboxServiceRef.current
        if (!inboxSvc) {
          return yield* Effect.fail(
            new Error("Inbox service unavailable — Inbox.defaultLayer must be running for the session tool to relay tasks"),
          )
        }
        const sendResult = yield* inboxSvc
          .send({
            receiverSessionID: childID,
            receiverActorID: childID,
            senderSessionID: ctx.sessionID as SessionID,
            senderActorID: ctx.actorID ?? "main",
            content: op.task,
          })
          .pipe(
            Effect.catchTag("InboxReceiverNotFound", () =>
              Effect.succeed({ inboxID: null as string | null }),
            ),
          )
        if (sendResult.inboxID === null) {
          return {
            title: `Send failed: ${op.sessionID} not reachable`,
            output:
              `Child ${op.sessionID} exists but has no inbox receiver row yet (it may not have started). ` +
              `Retry once it is running, or \`session create\` a fresh child.`,
            metadata: { sessionID: op.sessionID } as Metadata,
          }
        }
        return {
          title: `Relayed task to ${op.sessionID}`,
          output:
            `Enqueued the task into child ${op.sessionID} and woke it. ` +
            `It will run the relayed task as its next turn` +
            (actor.status === "running" || actor.status === "pending"
              ? ` (currently busy — the task is queued and drains after its current turn).`
              : `.`) +
            (yield* dispatchLedgerNotice(ctx.sessionID as SessionID, {
              id: childID,
              verb: "SENT THIS TASK TO",
              task: op.task,
            })),
          metadata: { sessionID: op.sessionID } as Metadata,
        }
      }

      if (op.action === "switch") {
        // Same prohibition the renderer enforces (cli/cmd/tui/routes/session/index.tsx).
        // The renderer is the choke point, but refusing here too is what reaches
        // the model mid-turn: a silent no-op would just make it retry.
        // NotFoundError is a synchronous throw inside an Effect.fn (a DEFECT, not
        // a typed failure — see the Worktree.create note above), so Effect.catch
        // can't see it; Effect.exit captures any non-success.
        const targetExit = yield* Effect.exit(sessions.get(op.sessionID as SessionID))
        if (targetExit._tag !== "Success")
          return {
            title: `Refused switch to ${op.sessionID}`,
            output: `Refused to move the UI to ${op.sessionID}: no such session. Run \`session list\` to see the child sessions you can switch to.`,
            metadata: { sessionID: op.sessionID } as Metadata,
          }
        const target = targetExit.value
        // Same shared helpers the renderer uses, so the criterion cannot drift
        // between the two enforcement points: they read the TARGET's own actor
        // rows, not its parent's child list.
        //
        // listBySession is typed as never-failing, so a DB error surfaces as a
        // defect — the same shape as the NotFoundError above, and equally
        // invisible to Effect.catch. Left unwrapped it would abort the whole tool
        // call, which reaches the model as a crash rather than as a decision; and
        // "rows could not be read" must NOT reach classifySession, because there
        // it would be indistinguishable from "this session has no rows" and would
        // fail open onto exactly the population the prohibition exists to refuse.
        const actorsExit = yield* Effect.exit(actorReg.listBySession(target.id as SessionID))
        const verdict =
          actorsExit._tag === "Success"
            ? classifySession(target, actorsExit.value)
            : classifyUnreadableActors(target, Cause.pretty(actorsExit.cause))
        if (!verdict.renderable)
          return {
            title: `Refused switch to ${op.sessionID}`,
            output:
              `Refused to move the UI to ${op.sessionID}: ${verdict.reason}. ` +
              (actorsExit._tag === "Success"
                ? `A session hosting a runtime-spawned agent is never rendered. `
                : `That is a read failure, not a prohibition: retry the switch, and if it keeps failing the actor registry is broken. `) +
              `Run \`session list\` to see the child sessions you can switch to, or switch to this session's parent instead.`,
            metadata: { sessionID: op.sessionID } as Metadata,
          }
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
        const enriched = yield* Effect.forEach(children, (child) =>
          actorReg.get(child.id, child.id).pipe(Effect.map((actor) => ({ child, actor }))),
        )
        const peers = enriched.filter(
          ({ actor }) => actor?.mode !== "subagent" && !(actor && SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent)),
        )
        if (peers.length === 0)
          return { title: "Child sessions: 0", output: "No child sessions.", metadata: {} as Metadata }
        // The actor row's status enum is only pending|running|idle; a terminal
        // idle carries a lastOutcome (success/failure/cancelled). deriveLiveness
        // maps (status, lastOutcome, lastActivityTime) to a display bucket:
        // running/pending split into progressing vs stalled by whether anything
        // LANDED within the staleness window (the PartUpdated projector bumps
        // last_activity_time per part — recent == progressing); terminal idle rows
        // map to success(→idle)/failure/cancelled. Never fabricate a state the
        // data lacks: a missing actor row is a plain idle.
        const now = Date.now()
        const bucketOf = ({ actor }: (typeof peers)[number]) => {
          if (!actor) return "idle" as const
          const live = deriveLiveness(actor, now)
          if (live === "progressing") return "progressing" as const
          if (live === "stalled") return "stalled" as const
          if (live === "cancelled") return "cancelled" as const
          if (live === "failure") return "failed" as const
          return "idle" as const
        }
        const tagged = peers.map((p) => ({ ...p, bucket: bucketOf(p) }))
        const counts = {
          progressing: tagged.filter((p) => p.bucket === "progressing").length,
          stalled: tagged.filter((p) => p.bucket === "stalled").length,
          idle: tagged.filter((p) => p.bucket === "idle").length,
          cancelled: tagged.filter((p) => p.bucket === "cancelled").length,
          failed: tagged.filter((p) => p.bucket === "failed").length,
        }
        const groups: { bucket: keyof typeof counts; heading: string }[] = [
          { bucket: "progressing", heading: "In progress — progressing (running/pending, advancing)" },
          { bucket: "stalled", heading: "In progress — stalled (running/pending, no recent activity)" },
          { bucket: "idle", heading: "Finished / idle" },
          { bucket: "failed", heading: "Failed" },
          { bucket: "cancelled", heading: "Cancelled" },
        ]
        const sections = groups
          .filter((g) => counts[g.bucket] > 0)
          .map((g) => {
            const lines = tagged
              .filter((p) => p.bucket === g.bucket)
              .map(
                ({ child, actor }) =>
                  `  ${child.id} — ${child.title} — ${actor?.agent ?? "?"} — ${actor?.status ?? "unknown"}`,
              )
            return `${g.heading} (${counts[g.bucket]}):\n${lines.join("\n")}`
          })
        const running = counts.progressing + counts.stalled
        const summary =
          `Child sessions: ${peers.length} total — ${running} running (${counts.progressing} progressing, ${counts.stalled} stalled), ${counts.idle} idle` +
          (counts.failed > 0 ? `, ${counts.failed} failed` : "") +
          (counts.cancelled > 0 ? `, ${counts.cancelled} cancelled` : "")
        return {
          title: `Child sessions: ${peers.length}`,
          output: [summary, "", ...sections].join("\n"),
          metadata: {} as Metadata,
        }
      }

      if (op.action === "dashboard") {
        // Fleet observability: the same peer set as `list`, but correlated to
        // (a) each child's derived liveness + turn telemetry, and (b) the git
        // worktree backing isolated children (dir + branch + commits-ahead) —
        // the mapping `list` never surfaced. Assembly is delegated to the pure
        // assembleFleet/renderFleetTable (tool/fleet.ts); here we only gather
        // the live inputs: sessions.children → actor rows → git worktree list.
        const children = yield* sessions.children(ctx.sessionID as SessionID)
        const enriched = yield* Effect.forEach(children, (child) =>
          actorReg.get(child.id, child.id).pipe(Effect.map((actor) => ({ child, actor }))),
        )
        const peers = enriched.filter(
          ({ actor }) => actor?.mode !== "subagent" && !(actor && SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent)),
        )
        if (peers.length === 0)
          return { title: "Fleet: 0", output: "No child sessions.", metadata: {} as Metadata }

        // Correlate worktrees from the orchestrator's own repo. `git worktree
        // list --porcelain` enumerates every worktree of the common repo (the
        // isolated children live under <data>/worktree/... of it); we resolve
        // each entry's directory to realpath so it matches a session.directory
        // (which the create branch sets to the worktree dir). commits-ahead is
        // computed per branch against the repo's default branch via rev-list.
        // Best-effort: any git failure degrades to no worktree correlation
        // rather than failing the dashboard.
        const orchestratorDir = yield* InstanceState.directory
        const worktrees = yield* collectWorktrees(git, orchestratorDir).pipe(
          Effect.catch(() => Effect.succeed([] as WorktreeEntry[])),
        )

        const inputs: FleetActorInput[] = peers.map(({ child, actor }) => ({
          session: { id: child.id, title: child.title, directory: child.directory },
          actor: actor ?? null,
        }))
        const summary = assembleFleet(inputs, worktrees, Date.now())
        return {
          title: `Fleet: ${summary.total}`,
          output: renderFleetTable(summary),
          metadata: {} as Metadata,
        }
      }


      if (op.action === "status") {
        // Derived pull-side liveness for one child. A peer registers with
        // session_id === actor_id === its own child id (see the create branch /
        // Actor.spawnPeer), so key the row by (childID, childID). deriveLiveness
        // turns the honest registry fields (status/lastOutcome/lastActivityTime)
        // into progressing|stalled|terminal — never fabricating a state the row
        // lacks.
        const childID = op.sessionID
        const found = yield* actorReg.liveness(childID as SessionID, childID)
        if (!found)
          return {
            title: `Status: ${childID} not found`,
            output: `No actor registered for ${childID}. It may not exist or never started.`,
            metadata: { sessionID: childID } as Metadata,
          }
        const age = (ms: number) => (ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`)
        const nowMs = Date.now()
        // Report the age the verdict was computed from FIRST. `?? time.created` is
        // the same fallback deriveLiveness uses, and the column is nullable so it
        // arrives as `null` — see AGENTS.md "Reading a nullable column".
        const activityAge = age(nowMs - (found.actor.lastActivityTime ?? found.actor.time.created))
        // turnCount/lastTurnTime stay on the dump as step bookkeeping, explicitly
        // labelled as not being what the liveness above was derived from.
        const turnAge = age(nowMs - found.actor.lastTurnTime)
        const outcome = found.actor.lastOutcome ? ` (last outcome: ${found.actor.lastOutcome})` : ""
        return {
          title: `Status ${childID}: ${found.liveness}`,
          output:
            `${childID} — ${found.liveness}${outcome}\n` +
            `  raw status: ${found.actor.status}\n` +
            `  lastActivityTime: ${found.actor.lastActivityTime ?? "(none)"} (${activityAge} ago) — liveness derives from this\n` +
            `  turnCount: ${found.actor.turnCount}\n` +
            `  lastTurnTime: ${found.actor.lastTurnTime} (${turnAge} ago) — last COMPLETED step, not the liveness input`,
          metadata: { sessionID: childID } as Metadata,
        }
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

      if (op.action === "join") {
        // Fan-in barrier: block until EVERY named child reaches a terminal state
        // (success/fail/cancel — all three notify via T41 and write lastOutcome),
        // then return one aggregated per-child summary. Peers register with
        // session_id === actor_id === their own child id (see the create branch /
        // Actor.spawnPeer), so both keys are the child session id. joinGroup does
        // not busy-wait — it subscribes to ActorStatusChanged and re-snapshots the
        // group as children settle. A bad/unknown id counts as "unknown" and never
        // blocks the barrier.
        const members = op.sessionIDs.map((sid) => ({
          sessionID: sid as SessionID,
          actorID: sid,
        }))
        const agg = yield* joinGroup(
          { reg: actorReg, sessions, bus },
          { members, ...(op.timeout_ms !== undefined ? { timeout_ms: op.timeout_ms } : {}) },
        )
        const lines = agg.members.map((m) => {
          const who = m.description ? `${m.actorID} (${m.description})` : m.actorID
          const detail =
            m.outcome === "success"
              ? m.reportedSummary ?? (m.result ? m.result.slice(0, 200) : "done")
              : m.outcome === "failure"
                ? m.error ?? "failed"
                : m.outcome === "cancelled"
                  ? "cancelled"
                  : "unknown (no registered actor)"
          return `  ${who} — ${m.outcome}: ${detail}`
        })
        const header =
          agg.status === "timeout"
            ? `Join TIMED OUT — ${agg.counts.success + agg.counts.failure + agg.counts.cancelled}/${agg.total} children terminal`
            : `Join complete — all ${agg.total} children terminal`
        const tally =
          `${agg.counts.success} success, ${agg.counts.failure} failed, ${agg.counts.cancelled} cancelled` +
          (agg.counts.unknown > 0 ? `, ${agg.counts.unknown} unknown` : "")
        return {
          title:
            agg.status === "timeout"
              ? `Join timed out (${agg.total} children)`
              : `Joined ${agg.total} children`,
          output: [`${header} (${tally}).`, "", ...lines].join("\n"),
          metadata: {} as Metadata,
        }
      }

      if (op.action === "setmode") {
        // A background peer resolves its mode each turn from the `agent` field on
        // the last message in its slice (prompt.ts) — inbox.drain carries that
        // forward to the wake message on the next relay. So changing the child's
        // mode = rewriting `agent` on its newest slice message(s); the change
        // takes effect on the child's NEXT turn. A peer's slice is agentID ===
        // its own sessionID. Always update the registry `agent` too (so `session
        // list` reflects the new mode; cosmetic — not read at turn time).
        const childID = op.sessionID as SessionID
        yield* actorReg.updateAgent(childID, childID, op.mode).pipe(Effect.catch(() => Effect.void))
        const slice = yield* sessions.messages({ sessionID: childID, agentID: childID })
        const lastUser = slice.findLast((m) => m.info.role === "user")
        const lastAssistant = slice.findLast((m) => m.info.role === "assistant")
        for (const m of [lastUser, lastAssistant]) {
          if (m) yield* sessions.updateMessage({ ...m.info, agent: op.mode })
        }
        const took = lastUser || lastAssistant
        return {
          title: `Set mode of ${op.sessionID} to ${op.mode}`,
          output: took
            ? `Child session ${op.sessionID} will run its next turn in ${op.mode} mode. ` +
              `Relay it a message (actor send) to continue under the new mode.`
            : `Set child ${op.sessionID} mode to ${op.mode} (registry updated; it has no turns yet, ` +
              `so the change applies once it starts).`,
          metadata: { sessionID: op.sessionID } as Metadata,
        }
      }

      if (op.action === "grant-approval") {
        // Pre-authorize FUTURE permission asks from a child (or all children):
        // when such an ask forwards, it auto-resolves allow without a human. The
        // grant is keyed by THIS orchestrator's session id (the parent) so it
        // scopes to this orchestrator's children only.
        // Store "all" as the "*" wildcard the grant check understands.
        forwardRef.setGrant(ctx.sessionID, op.target === "all" ? "*" : op.target)
        return {
          title: `Approval granted for ${op.target}`,
          output:
            op.target === "all"
              ? `Future permission asks from ANY of your child sessions will be auto-approved.`
              : `Future permission asks from child ${op.target} will be auto-approved.`,
          metadata: {} as Metadata,
        }
      }

      if (op.action === "approve") {
        // One-shot approval of a child's CURRENT pending forwarded ask. The
        // pending record carries a resolver bound to the child's own Deferred (in
        // the child's Instance), so this works whether the child shares our
        // Instance or runs in its own worktree. resolve() is idempotent and a
        // no-op if the user already approved directly (structural dedup).
        const approved = forwardRef.resolve(op.sessionID, "allow")
        return {
          title: approved ? `Approved ${op.sessionID}` : `No pending approval for ${op.sessionID}`,
          output: approved
            ? `Approved child ${op.sessionID}'s pending permission request.`
            : `Child ${op.sessionID} has no pending permission request to approve.`,
          metadata: { sessionID: op.sessionID } as Metadata,
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
