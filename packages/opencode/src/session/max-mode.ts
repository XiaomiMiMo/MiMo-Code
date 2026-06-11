import { Cause, Effect } from "effect"
import * as Stream from "effect/Stream"
import type { ModelMessage, Tool as AITool } from "ai"
import { LLM } from "./llm"
import { SessionProcessor } from "./processor"
import * as Session from "./session"
import type { Provider } from "@/provider"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import type { Permission } from "@/permission"
import { Log } from "@/util"

const log = Log.create({ service: "session.max-mode" })

export const DEFAULT_CANDIDATES = 5

/** Name of the built-in max-mode primary agent. */
export const MAX_MODE_AGENT = "max"

/** One candidate's collected output from a propose-only stream. */
export type Candidate = {
  index: number
  reasoning: string
  reasoningMetadata?: Record<string, any>
  text: string
  textMetadata?: Record<string, any>
  toolCalls: SessionProcessor.ProposedToolCall[]
  finishReason: string
  usage?: any
  providerMetadata?: Record<string, any>
}

/**
 * Shared inputs for a max-mode step. These mirror exactly what the runLoop has
 * in scope at the main `handle.process` call site, so the orchestrator can be
 * dropped in with no extra plumbing.
 */
export type MaxStepInput = {
  handle: SessionProcessor.Handle
  llm: LLM.Interface
  user: MessageV2.User
  agent: Agent.Info
  model: Provider.Model
  sessionID: string
  parentSessionID?: string
  permission?: Permission.Ruleset
  /** Custom system additions (same array passed to handle.process). */
  system: string[]
  /** Prebuilt system array (verbatim) — same as handle.process. */
  prebuiltSystem?: string[]
  /** Model messages for this step. */
  messages: ModelMessage[]
  /** Execute-bearing tools from resolveTools — used to run the winner. */
  tools: Record<string, AITool>
  agentID?: string
  /**
   * Tool-choice from the per-step args. Accepted (so the same processArgs object
   * can be spread in) but unused: candidates always run propose-only and the
   * json_schema path never takes the max-mode branch.
   */
  toolChoice?: "auto" | "required" | "none"
  /** Number of parallel candidates (default 5). */
  candidates?: number
  /**
   * Optional hook to surface progress to the UI during the (otherwise
   * invisible) candidate + judge phases. Called with a short English label,
   * or undefined to clear back to a plain busy state.
   */
  setStatus?: (message: string | undefined) => Effect.Effect<void>
}

/**
 * Strip the `execute` closure from each tool, yielding "schema-only" tools.
 * The AI SDK stops the step and emits a `tool-call` event (without executing)
 * when an invoked tool has no `execute` — exactly the propose-only behaviour
 * candidates need.
 */
export function toSchemaOnlyTools(tools: Record<string, AITool>): Record<string, AITool> {
  const out: Record<string, AITool> = {}
  for (const [key, t] of Object.entries(tools)) {
    const { execute: _execute, ...rest } = t as any
    out[key] = rest as AITool
  }
  return out
}

/**
 * Run a single propose-only candidate stream, collecting reasoning + text +
 * proposed tool calls without executing anything. Returns null on failure so a
 * single bad draw doesn't sink the whole step.
 *
 * Transient network failures (ECONNRESET / EPIPE / SSE timeout / 5xx) are
 * retried with the same persistent schedule the normal stream path uses. This
 * is safe — and deliberately broader than the normal path — because a
 * candidate emits NOTHING externally until it completes: each attempt rebuilds
 * a fresh accumulator, so re-streaming after a mid-stream reset cannot
 * duplicate user-visible output the way the live processor stream would. A
 * mid-stream ECONNRESET that the normal path can't retry (it only wraps
 * connection setup) is fully recoverable here.
 */
// Exported for integration tests (drives the real candidate path with a mock
// llm.stream). Not part of the public surface — call sites use runMaxStep.
export const runCandidate = (input: MaxStepInput, index: number): Effect.Effect<Candidate | null> =>
  Effect.gen(function* () {
    // Fresh accumulator per attempt: the retry below re-runs this whole block,
    // so partial reasoning/text/toolCalls from a failed attempt must not carry
    // over into the retry.
    const candidate: Candidate = {
      index,
      reasoning: "",
      text: "",
      toolCalls: [],
      finishReason: "stop",
    }

    const schemaOnly = toSchemaOnlyTools(input.tools)
    const stream = input.llm.stream({
      user: input.user,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      model: input.model,
      agent: input.agent,
      permission: input.permission,
      system: input.system,
      prebuiltSystem: input.prebuiltSystem,
      messages: input.messages,
      tools: schemaOnly,
      agentID: input.agentID,
    })

    yield* Stream.runForEach(stream, (event: LLM.Event) => {
      switch (event.type) {
        case "reasoning-delta":
          candidate.reasoning += event.text
          if (event.providerMetadata) candidate.reasoningMetadata = event.providerMetadata
          break
        case "text-delta":
          candidate.text += event.text
          if (event.providerMetadata) candidate.textMetadata = event.providerMetadata
          break
        case "tool-call":
          candidate.toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: (event.input as Record<string, any>) ?? {},
            providerMetadata: event.providerMetadata,
          })
          break
        case "finish-step":
          candidate.finishReason = event.finishReason ?? candidate.finishReason
          candidate.usage = event.usage
          candidate.providerMetadata = event.providerMetadata
          break
        // The AI SDK surfaces a transient stream failure (ECONNRESET etc.) as
        // an `error` PART that ends the stream normally — it does NOT throw, and
        // the normal processor path only converts this via its own catchCause.
        // Emit it into the Effect error channel (NOT a thrown defect, which the
        // retry's `while` predicate would skip) so Effect.retry below can fire;
        // otherwise the error is silently swallowed and the candidate ends
        // half-streamed.
        case "error":
          return Effect.fail(event.error)
        default:
          break
      }
      return Effect.void
    })

    return candidate
  }).pipe(
    // Mirror the proven build/plan path (processor.ts): convert any DEFECT into
    // a typed failure before retrying. The SSE-timeout / aborted-fetch errors
    // raised deep in the provider stream surface as defects (Cause.die), which
    // Effect.retry's `while` and Effect.catch both skip — so without this they
    // escape the fiber as an unhandled rejection and kill the whole session.
    // Interrupts (genuine user cancel) are left to propagate.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.fail(Cause.squash(cause)),
    ),
    Effect.retry({
      while: LLM.isTransientCapacityError,
      schedule: LLM.persistentRetrySchedule,
    }),
    Effect.catch((e) =>
      Effect.sync(() => {
        log.warn("candidate failed", { index, error: e instanceof Error ? e.message : String(e) })
        return null
      }),
    ),
  )

/** Render a candidate compactly for the judge. `label` is its judge-facing index. */
function renderCandidate(c: Candidate, label: number): string {
  const tools =
    c.toolCalls.length === 0
      ? "(no tool calls — final answer / text only)"
      : c.toolCalls
          .map((t) => `  - ${t.toolName}(${JSON.stringify(t.input)})`)
          .join("\n")
  const reasoning = c.reasoning.trim() ? c.reasoning.trim() : "(no reasoning emitted)"
  const text = c.text.trim() ? c.text.trim() : "(no text emitted)"
  return [
    `### Candidate ${label}`,
    `Reasoning:\n${reasoning}`,
    `Message:\n${text}`,
    `Proposed tool calls:\n${tools}`,
  ].join("\n")
}

const JUDGE_SYSTEM = [
  "You are a judge selecting the single best next step for a coding agent.",
  "You will see several independent candidate drafts for the SAME step. Each candidate contains its reasoning, its message text, and the tool calls it proposes to make next.",
  "Pick the ONE candidate that has the most correct, grounded, and useful next step. Prefer candidates whose reasoning is sound and whose proposed tool calls are appropriate and safe.",
  "Respond with ONLY the integer index of the winning candidate (e.g. `2`). No other text.",
].join("\n")

/**
 * Parse the judge's free-text reply into a valid candidate index. Returns 0
 * (first survivor) when the reply has no integer or is out of range — so a
 * flaky judge never blocks the step.
 */
export function parseJudgeIndex(out: string, count: number): number {
  const match = out.match(/\d+/)
  if (!match) return 0
  const picked = parseInt(match[0], 10)
  if (Number.isNaN(picked) || picked < 0 || picked >= count) return 0
  return picked
}

/**
 * Ask the model to pick the best candidate. Returns the winner's index in the
 * `candidates` array (NOT the candidate.index field) plus the judge call's own
 * token usage. Falls back to index 0 on any parse/out-of-range issue.
 */
/** Exported for integration tests; call sites go through runMaxStep. */
export const judge = (input: MaxStepInput, candidates: Candidate[]): Effect.Effect<{ pick: number; usage?: any }> =>
  Effect.gen(function* () {
    if (candidates.length === 1) return { pick: 0, usage: undefined }

    const rendered = candidates.map((c, i) => renderCandidate(c, i)).join("\n\n")
    const judgePrompt = [
      `There are ${candidates.length} candidates, indexed 0..${candidates.length - 1}.`,
      "",
      rendered,
      "",
      `Reply with ONLY the integer index (0..${candidates.length - 1}) of the best candidate.`,
    ].join("\n")

    const messages: ModelMessage[] = [{ role: "user", content: judgePrompt }]

    let out = ""
    let usage: any | undefined
    const stream = input.llm.stream({
      user: input.user,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      model: input.model,
      agent: input.agent,
      permission: input.permission,
      system: [JUDGE_SYSTEM],
      messages,
      tools: {},
      toolChoice: "none",
      agentID: input.agentID,
    })

    yield* Stream.runForEach(stream, (event: LLM.Event) => {
      if (event.type === "text-delta") out += event.text
      else if (event.type === "finish-step") usage = event.usage
      // Same as runCandidate: a transient failure arrives as an `error` part,
      // not a thrown error. Surface it into the error channel so Effect.retry
      // below can fire instead of silently picking candidate 0.
      else if (event.type === "error") return Effect.fail(event.error)
      return Effect.void
    })

    return { pick: parseJudgeIndex(out, candidates.length), usage }
  }).pipe(
    // Convert defects (SSE timeout / aborted fetch surfacing as Cause.die) into
    // typed failures before retrying — same as runCandidate and the proven
    // processor path. Otherwise the defect escapes and kills the session
    // instead of degrading to pick 0.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.fail(Cause.squash(cause)),
    ),
    // Same transient-retry rationale as runCandidate: the judge accumulates
    // `out`/`usage` locally and emits nothing externally until it returns, so
    // re-streaming after a mid-stream reset is safe. Without this, a single
    // ECONNRESET during judging silently collapses the whole step to pick 0.
    Effect.retry({
      while: LLM.isTransientCapacityError,
      schedule: LLM.persistentRetrySchedule,
    }),
    Effect.catch((e) => {
      log.warn("judge failed, defaulting to candidate 0", {
        error: e instanceof Error ? e.message : String(e),
      })
      return Effect.succeed({ pick: 0, usage: undefined })
    }),
  )

/**
 * Run one max-mode step: N parallel propose-only candidates → judge picks the
 * winner → replay (execute) the winner through the processor. Returns the same
 * Result contract as `handle.process`.
 *
 * Degradation: if every candidate fails (0 survivors), falls back to a normal
 * single `handle.process` call so the step still makes progress.
 */
export const runMaxStep = (input: MaxStepInput): Effect.Effect<SessionProcessor.Result> =>
  Effect.gen(function* () {
    const n = Math.max(1, input.candidates ?? DEFAULT_CANDIDATES)
    const setStatus = (message: string | undefined) =>
      input.setStatus ? input.setStatus(message) : Effect.void

    // Total wall-clock of the whole ensemble phase (N parallel candidates +
    // judge), measured from just before the candidates start until just before
    // replay. Shown as the winner's thinking duration.
    const ensembleStartedAt = Date.now()

    yield* setStatus(`thinking — ${n} candidates`)
    const results = yield* Effect.all(
      Array.from({ length: n }, (_, i) => runCandidate(input, i)),
      { concurrency: n },
    )
    const survivors = results.filter((c): c is Candidate => c !== null)

    if (survivors.length === 0) {
      log.warn("all candidates failed, falling back to single process")
      yield* setStatus(undefined)
      return yield* input.handle.process({
        user: input.user,
        agent: input.agent,
        permission: input.permission,
        sessionID: input.sessionID,
        parentSessionID: input.parentSessionID,
        system: input.system,
        prebuiltSystem: input.prebuiltSystem,
        messages: input.messages,
        tools: input.tools,
        model: input.model,
        agentID: input.agentID,
      })
    }

    yield* setStatus(`judging ${survivors.length} candidates`)
    const { pick, usage: judgeUsage } = yield* judge(input, survivors)
    const winner = survivors[pick]
    log.info("max step", { candidates: n, survivors: survivors.length, winner: pick, toolCalls: winner.toolCalls.length })

    // The winner's own usage is what actually enters history, so it (and only
    // it) must drive the message's `tokens` — that field feeds the context
    // overflow / prune / compaction estimators. Feeding the aggregate there
    // would make max mode believe context is ~Nx fuller than it is and trigger
    // premature compaction.
    //
    // The losing candidates + the judge are real spend but consume NO context.
    // We surface them as `overhead`: extra cost + extra in/out token counts the
    // processor adds to `cost` and the ModelCall metric only — never to
    // `tokens`. So billing/metrics reflect the true ~Nx spend while context
    // estimation stays honest.
    const overheadUsages = [...survivors.filter((_, i) => i !== pick).map((c) => c.usage), judgeUsage]
    const overhead = overheadUsages.reduce(
      (acc, u) => {
        if (!u) return acc
        const g = Session.getUsage({ model: input.model, usage: u })
        acc.cost += g.cost
        acc.tokensIn += g.tokens.input + g.tokens.cache.read + g.tokens.cache.write
        acc.tokensOut += g.tokens.output + g.tokens.reasoning
        return acc
      },
      { cost: 0, tokensIn: 0, tokensOut: 0 },
    )

    // Clear the max-mode label before replay so the winner streams under the
    // normal busy state.
    yield* setStatus(undefined)
    return yield* input.handle.replay({
      reasoning: winner.reasoning,
      reasoningMetadata: winner.reasoningMetadata,
      text: winner.text,
      textMetadata: winner.textMetadata,
      toolCalls: winner.toolCalls,
      finishReason: winner.finishReason,
      usage: winner.usage,
      providerMetadata: winner.providerMetadata,
      tools: input.tools as any,
      messages: input.messages,
      selection: { winner: pick, total: survivors.length },
      thinkingMs: Date.now() - ensembleStartedAt,
      overhead,
    })
  })

export * as MaxMode from "./max-mode"
