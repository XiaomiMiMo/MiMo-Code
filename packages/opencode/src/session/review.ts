import { createHash } from "node:crypto"
import { Deferred, Effect } from "effect"
import { Actor } from "@/actor/spawn"
import { Config } from "@/config"
import { Git } from "@/git"
import { TaskRegistry } from "@/task/registry"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import * as Session from "./session"
import { ReviewGateState } from "./review-gate-state"
import { Log } from "@/util"
import type { AgentOutcome } from "@/actor/spawn"

const log = Log.create({ service: "session.review" })

export const DEFAULT_MAX_REVIEW_ROUNDS = 3

/** Tools the read-only reviewer may use. No shell, no edits. */
export const REVIEW_TOOLS = ["read", "grep", "glob", "codesearch"] as const

/** JSON Schema (not zod) — passed straight to the structured-output format. */
export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string" },
          detail: { type: "string" },
          fix_suggestion: { type: "string" },
        },
        required: ["file", "severity", "title", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const

export interface Finding {
  file: string
  line?: number
  severity: "high" | "medium" | "low"
  title: string
  detail: string
  fix_suggestion?: string
}

export type ReviewDecision =
  | { needReentry: false; reason: "disabled" | "not-main" | "in-flight" | "no-diff" | "tasks-open" | "dedup" | "cap" }
  | { needReentry: true }

export interface DecideInput {
  isMain: boolean
  autoEnabled: boolean
  inFlight: boolean
  count: number
  maxRounds: number
  sessionHasTasks: boolean
  allTasksTerminal: boolean
  hasUncommittedChanges: boolean
  diffHash: string
  lastReviewedHash: string | undefined
}

/**
 * Pure decision — unit-testable without any services. Mirrors TaskGate.decide's
 * fail-open posture: every skip reason allows stop.
 */
export function decide(input: DecideInput): ReviewDecision {
  if (!input.isMain) return { needReentry: false, reason: "not-main" }
  if (!input.autoEnabled) return { needReentry: false, reason: "disabled" }
  if (input.inFlight) return { needReentry: false, reason: "in-flight" }
  if (input.sessionHasTasks && !input.allTasksTerminal) return { needReentry: false, reason: "tasks-open" }
  if (!input.hasUncommittedChanges) return { needReentry: false, reason: "no-diff" }
  if (input.diffHash === input.lastReviewedHash) return { needReentry: false, reason: "dedup" }
  if (input.count >= input.maxRounds) return { needReentry: false, reason: "cap" }
  return { needReentry: true }
}

export function hashDiff(diffText: string): string {
  return createHash("sha1").update(diffText).digest("hex")
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

/** Narrow an AgentOutcome's structured output to a Finding[]; malformed → []. */
export function extractFindings(outcome: AgentOutcome): Finding[] {
  if (outcome.status !== "success") return []
  const structured = outcome.structured
  if (!isRecord(structured)) return []
  const arr = structured["findings"]
  if (!Array.isArray(arr)) return []
  return arr.filter(isRecord) as unknown as Finding[]
}

export function findingsText(findings: Finding[]): string {
  const lines = findings.map(
    (f) =>
      `- **${f.severity.toUpperCase()}** \`${f.file}${f.line ? `:${f.line}` : ""}\`: ${f.title} — ${f.detail}` +
      (f.fix_suggestion ? `\n  Fix: ${f.fix_suggestion}` : ""),
  )
  return [
    "<system-reminder>",
    "An independent reviewer found issues in your changes. Fix them before stopping:",
    "",
    ...lines,
    "",
    "If a finding is a false positive, address it explicitly (explain why) or make the fix.",
    "Do not finish until the findings above are resolved.",
    "</system-reminder>",
  ].join("\n")
}

function buildReviewTask(input: { worktree: string; diffText: string }): string {
  return [
    "Review the following uncommitted changes for bugs, structure, performance, and behavior changes.",
    "",
    "Changed files & diff (git diff + git diff --cached):",
    "```diff",
    input.diffText || "(empty diff)",
    "```",
    "",
    `Working directory: ${input.worktree}`,
    "",
    "Read the full files behind the diff with the read/grep/glob/codesearch tools when you need context.",
    "Produce your findings as the structured output described in your instructions.",
  ].join("\n")
}

function readDiff(git: Git.Interface, worktree: string) {
  const runDiff = (args: string[]) =>
    Effect.gen(function* () {
      const result = yield* git.run(args, { cwd: worktree })
      return result.exitCode === 0 ? result.text() : ""
    }).pipe(Effect.orElseSucceed(() => ""))
  return Effect.gen(function* () {
    const unstaged = yield* runDiff(["diff", "--no-ext-diff", "--no-renames", "--", "."])
    const staged = yield* runDiff(["diff", "--cached", "--no-ext-diff", "--no-renames", "--", "."])
    return `${unstaged}\n${staged}`
  })
}

export interface ShouldReenterInput {
  sessionID: SessionID
  worktree: string
  agent: string
  lastUser: MessageV2.User
  cfg: Config.Info
  state: ReviewGateState.Interface
  taskReg: TaskRegistry.Interface
  git: Git.Interface
  actor: Actor.Interface
  sessions: Session.Interface
}

/**
 * Main gate body. Returns true when the loop must re-enter (findings injected),
 * false when the agent may stop. Fail-open on every failure path.
 */
export const shouldReenter = Effect.fn("ReviewGate.shouldReenter")(function* (input: ShouldReenterInput) {
  const { sessionID, worktree, agent, lastUser, cfg, state, taskReg, git, actor, sessions } = input

  const allTasks = yield* taskReg
    .list({ session_id: sessionID, include_terminal: true })
    .pipe(Effect.orElseSucceed(() => []))
  const nonTerminal = yield* taskReg
    .list({ session_id: sessionID, include_terminal: false })
    .pipe(Effect.orElseSucceed(() => []))
  const sessionHasTasks = allTasks.length > 0
  const allTasksTerminal = nonTerminal.length === 0

  const diffText = yield* readDiff(git, worktree)
  const hasUncommittedChanges = diffText.trim().length > 0
  const diffHash = hashDiff(diffText)

  const count = yield* state.get(sessionID)
  const lastReviewedHash = yield* state.getLastReviewedHash(sessionID)
  const inFlight = yield* state.inFlight(sessionID)

  const decision = decide({
    isMain: agent === "main",
    autoEnabled: cfg.review?.auto !== false,
    inFlight,
    count,
    maxRounds: cfg.review?.max_review_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS,
    sessionHasTasks,
    allTasksTerminal,
    hasUncommittedChanges,
    diffHash,
    lastReviewedHash,
  })

  if (!decision.needReentry) return false

  yield* state.setInFlight(sessionID, true)
  const spawned = yield* actor
    .spawn({
      mode: "subagent",
      sessionID,
      agentType: "review",
      task: buildReviewTask({ worktree, diffText }),
      description: "auto-review",
      context: "none",
      tools: REVIEW_TOOLS,
      background: false,
      format: { type: "json_schema", schema: FINDINGS_SCHEMA, retryCount: 2 },
    })
    .pipe(Effect.catch((err) => {
      log.warn("review spawn failed; allowing stop", { error: String(err) })
      return Effect.succeed(null)
    }))
  yield* state.setInFlight(sessionID, false)

  if (!spawned) return false

  const outcome = yield* Deferred.await(spawned.outcome).pipe(Effect.catch(() => Effect.succeed(null)))
  if (!outcome) return false

  const findings = extractFindings(outcome)
  if (findings.length === 0) {
    yield* state.clear(sessionID)
    yield* state.setLastReviewedHash(sessionID, diffHash)
    log.info("review clean; allowing stop", { sessionID })
    return false
  }

  yield* state.bump(sessionID)
  yield* state.setLastReviewedHash(sessionID, diffHash)

  const reentry = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agentID: lastUser.agentID,
    agent: lastUser.agent,
    model: lastUser.model,
    tools: lastUser.tools,
    format: lastUser.format,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: reentry.id,
    sessionID,
    type: "text",
    synthetic: true,
    text: findingsText(findings),
  } satisfies MessageV2.TextPart)
  log.info("review findings injected; re-entering", { sessionID, count: findings.length })
  return true
})

export * as ReviewGate from "./review"
