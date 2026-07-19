import { Effect, Deferred, Context, Fiber, Layer, Scope, Cause, Schedule } from "effect"
import type { SessionID, MessageID } from "@/session/schema"
import type { ProviderID, ModelID } from "@/provider/schema"
import type { Tool as AITool, ModelMessage } from "ai"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { ActorRegistry } from "@/actor/registry"
import { TaskRegistry } from "@/task/registry"
import { TaskGate, MAX_TASK_GATE_SUBAGENT_REACT } from "@/task/gate"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import type { Actor, SpawnMode, ContextMode, ToolWhitelist, Lifecycle } from "@/actor/schema"
import { deriveLiveness, DEFAULT_LIVENESS_STALL_MS } from "@/actor/schema"
import * as ActorEvents from "@/actor/events"
import { runTurn } from "@/actor/turn"
import { spawnRef } from "@/actor/spawn-ref"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { MessageV2 } from "@/session/message-v2"
import { Inbox } from "@/inbox"
import { renderActorNotification } from "@/inbox/render"
import { Plugin, HookEvent } from "@/plugin"
import { parseReturnHeader, type ReturnStatus } from "./return-header"
import { Log } from "@/util"
import { Instance, type InstanceContext } from "@/project/instance"
import { InstanceRef } from "@/effect/instance-ref"

const log = Log.create({ service: "actor.spawn" })

/**
 * Cap on preStop ReAct re-entries per spawn — prevents infinite loops.
 * TODO: lift to mimocode.json config (e.g. actor.maxPreReact) and add per-hook
 * `maxContinue` clamp at registration. Plan: platform cap = hard ceiling, hook
 * cap may only narrow, never widen. See spec Future work.
 */
export const MAX_PRE_REACT = 3
/** Cap on postStop ReAct re-entries per spawn. See MAX_PRE_REACT TODO. */
export const MAX_POST_REACT = 3
/**
 * T40 stall watchdog scan cadence. Sits between the per-step turn heartbeat and
 * the DEFAULT_LIVENESS_STALL_MS (90s) window, and just under the registry's own
 * 60s stuck-scan, so a genuinely stalled child is caught within ~one window of
 * flipping to `stalled` without hammering the DB.
 */
export const WATCHDOG_SCAN_INTERVAL_MS = 45_000
const RETURN_FORMAT_INSTRUCTION = `

---

## Return format (required)

Your FINAL assistant message — what the spawning agent will receive — MUST start with this header block:

  **Status**: success | partial | failed | blocked
  **Summary**: <one sentence describing what happened>

After the header, include the actual deliverable (whatever the task asked for in its prompt).

If applicable, also include below the deliverable:

  **Files touched**: <comma-separated paths or "(none)">
  **Findings worth promoting**: <bullet list of cross-task transferable facts; "(none)" if just routine work>

This format lets the spawning agent and the checkpoint writer extract your progress without parsing free-form prose. Do NOT precede the header with an introduction — your final message must start with "**Status**:".
`

export interface ForkContext {
  readonly system: string[]
  /**
   * Tool schema as parent would emit at watermark, captured for invariant
   * verification only. NOT consumed by fork's runLoop for the actual LLM
   * request — that uses `resolveTools(forkAgent)` for executable tools with
   * dispatch closures. Schema parity is currently enforced because
   * checkpoint-writer has no `toolAllowlist` (Task 2.6); both paths call
   * `registry.tools` with equivalent agent inputs and produce identical
   * schemas. If `toolAllowlist` is ever re-added, this field would still
   * snapshot parent's schema while the runtime tools would diverge, silently
   * breaking cache parity. Test guard: `test/agent/agent.test.ts` asserts
   * `cp.toolAllowlist === undefined` for checkpoint-writer.
   */
  readonly tools: Record<string, AITool>
  /**
   * Parent agent's permission ruleset, captured at spawn. The fork evaluates
   * permissions and filters its LLM-visible tool list against THIS (the parent's)
   * ruleset rather than the checkpoint-writer agent's own — restoring prompt-cache
   * tool-visibility parity with the parent and keeping permission semantics
   * consistent with the captor. Memory-tree writes are still governed by
   * memory-path-guard (see askEditUnlessMemory), so an inherited `edit:deny`
   * does not block the writer's own checkpoint files.
   */
  readonly parentPermission: Permission.Ruleset
  readonly inheritedMessages: ModelMessage[]
  /**
   * Boundary marker — the last main-slice message id at spawn. Used by fork's
   * runLoop to filter ownNew messages (belt-and-braces alongside the agent_id
   * check; agent_id is sufficient on its own, watermark is the documentary
   * anchor). NEVER use this for slicing inheritedMessages — inheritedMessages
   * is captured as a complete snapshot at spawn time.
   * See docs/superpowers/specs/2026-05-26-fork-agent-prefix-cache-design.md
   */
  readonly watermarkMsgID: MessageID
  readonly model: { providerID: ProviderID; modelID: ModelID }
}

export type AgentOutcome =
  | {
      status: "success"
      finalText?: string
      // Structured-output (json_schema) result — when the spawn requested a
      // format, the validated object is surfaced here and takes precedence over
      // finalText (DW spec P3).
      structured?: unknown
      // Subagent's self-reported header status (parsed from finalText), possibly
      // overridden by the completion gate (DB truth wins — see onSuccess).
      reportedStatus?: ReturnStatus
      reportedSummary?: string
      // Task IDs the subagent left non-terminal after the gate's cap. Present
      // only when reportedStatus was downgraded to "partial"/"blocked".
      incompleteTasks?: string[]
    }
  | { status: "failure"; error: string }
  | { status: "cancelled" }

export interface SpawnInput {
  mode: SpawnMode
  sessionID: SessionID
  /**
   * Parent session id when the actor runs in a child session (Axis A: checkpoint
   * writer spawns under a child session keyed on parent_id but writes to the
   * parent's checkpoint.md / memory.md). Hooks (actor.preStop / actor.postStop)
   * receive this so plugins re-deriving paths from sessionID can fall back to
   * `parentSessionID ?? sessionID` and reach the parent's artifacts.
   *
   * Defaults to `sessionID` inside spawnSubagent when omitted, so existing
   * callers (peer / dream / distill / regular subagents where parent ===
   * session) need no change.
   */
  parentSessionID?: SessionID
  agentType: string
  task: string
  description?: string
  context: ContextMode
  tools: ToolWhitelist
  model?: { providerID: ProviderID; modelID: ModelID }
  background: boolean
  parentActorID?: string
  task_id?: string // Spec ②: bound user-task ID for postStop progress.md validation
  // Peer-only: directory the child session runs in. When set, the child's work
  // fiber is bound to that directory's Instance (via InstanceRef) so all its
  // file tools / write boundary resolve against it — i.e. real isolation. A
  // worktree is just such a directory; whether to CREATE one is the caller's
  // policy (the session tool creates a worktree and passes its dir here). When
  // unset, the child shares the spawner's directory.
  cwd?: string
  forkContext?: ForkContext // NEW
  lifecycle?: Lifecycle
  /**
   * Optional structured-output format. When set to a json_schema format, the
   * child's SessionPrompt.prompt requests structured output: the runLoop injects
   * the StructuredOutput tool, forces toolChoice=required, and the validated
   * object flows back via message.structured (see runAgentLoop). The validated
   * object is surfaced on AgentOutcome.structured.
   */
  format?: MessageV2.OutputFormat
  /**
   * Fired SYNCHRONOUSLY with the freshly-allocated actorID inside the spawn
   * Effect — right after the actor is registered, BEFORE its work fiber detaches
   * (forkWork forks into the actor scope). Lets a caller record the child id the
   * instant the actor exists, closing the window where an in-flight spawn would
   * otherwise be invisible to a concurrent cancel/reclaim. The WorkflowRuntime
   * uses this to add the id to its reclaim set before detach (MR104 #2). Best-
   * effort: a throw is swallowed so a buggy callback can't fail the spawn. Only
   * the subagent path invokes it (the workflow spawns subagents); spawnPeer does
   * not — peers are not orchestrated by the workflow runtime.
   */
  onActorID?: (actorID: string) => void
  /**
   * Fired as an Effect BEFORE Fiber.join (for non-background spawns). Lets the
   * caller emit metadata (sessionId/actorId) to the tool part state while the
   * tool is still "running" — critical for the TUI to navigate into a running
   * subagent. The callback receives the allocated actorID and sessionID.
   * Swallowed on failure (best-effort, same as onActorID).
   */
  onReady?: (info: { actorID: string; sessionID: SessionID }) => Effect.Effect<void>
}

export interface SpawnResult {
  actorID: string
  sessionID: SessionID
  outcome: Deferred.Deferred<AgentOutcome>
}

export interface Interface {
  readonly spawn: (input: SpawnInput) => Effect.Effect<SpawnResult>
  readonly cancel: (sessionID: SessionID, actorID: string, mode: "graceful" | "forced") => Effect.Effect<void>
  readonly getForkContext: (actorID: string) => Effect.Effect<ForkContext | undefined>
  /**
   * Run ONE stall-watchdog scan pass synchronously (the same body the background
   * fiber repeats every WATCHDOG_SCAN_INTERVAL_MS). Exposed for deterministic
   * tests that can't wait a real scan interval — it shares the same `notified`
   * debounce set as the fiber, so driving it repeatedly exercises the real
   * one-shot / re-arm semantics without touching wall-clock scheduling.
   * Optional so lightweight test mocks of this Service need not implement it.
   */
  readonly scanStalledOnce?: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Actor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const actorReg = yield* ActorRegistry.Service
    const agents = yield* Agent.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const inbox = yield* Inbox.Service
    const state = yield* SessionRunState.Service
    const plugin = yield* Plugin.Service
    const bus = yield* Bus.Service
    const taskRegistry = yield* TaskRegistry.Service
    const scope = yield* Scope.Scope

    // ForkContext snapshot per actor, captured at spawn for fork agents
    // (contextMode = "full"). Read by fork's runLoop (see prompt.ts) and
    // cleared on terminal status. Fiber tracking moved to SessionRunState.
    const forkContexts = new Map<string, ForkContext>()

    // Actors whose cancel() has begun, keyed "sessionID:actorID". Populated
    // BEFORE the fiber is interrupted so forkWork's onSuccess/onFailure notify
    // can suppress its own (misleading) emit — a cancelled child's interrupt is
    // masked by the runLoop onInterrupt handler (returns lastAssistant), so the
    // work fiber sees a spurious "success". The authoritative "cancelled"
    // notification is emitted instead by Actor.cancel via notifyTerminal, which
    // runs in-context after updateStatus. This unifies success/failure/cancel
    // onto one parent-notification contract without double-notifying. See T41.
    const cancelling = new Set<string>()
    const cancelKey = (sessionID: SessionID, actorID: string) => `${sessionID}:${actorID}`

    // Real agent loop: marks the actor running, then drives a SessionPrompt.prompt
    // turn. The user message persisted by SessionPrompt carries the actor's
    // agentID, which the projector writes to MessageTable.agent_id — that is the
    // load-bearing piece this primitive exists for.
    //
    // Returns the assistant's final text (if any) so forkWork's onSuccess can
    // pass it to inbox.send (notification body) and into the success Deferred.
    const runAgentLoop = Effect.fn("Actor.runAgentLoop")(function* (input: {
      sessionID: SessionID
      actorID: string
      agentType: string
      task: string
      task_id?: string
      model?: { providerID: ProviderID; modelID: ModelID }
      source: "spawn" | "hook"
      provenance?: MessageV2.Provenance
      format?: MessageV2.OutputFormat
    }) {
      const result = yield* sessionPrompt.prompt({
        sessionID: input.sessionID,
        agent: input.agentType,
        agentID: input.actorID,
        source: input.source,
        provenance: input.provenance,
        model: input.model,
        task_id: input.task_id,
        parts: [{ type: "text", text: input.task }],
        ...(input.format ? { format: input.format } : {}),
      })
      // structured output (json_schema) takes precedence over finalText: when the
      // child produced a validated object it IS the authoritative result and the
      // last text part (often a pre-tool-call preamble) is dropped to avoid
      // duplicating the result downstream. See spec §5.2.
      const info = (result as MessageV2.WithParts | undefined)?.info
      const structured = info?.role === "assistant" ? info.structured : undefined
      const finalText =
        structured !== undefined
          ? undefined
          : (result as MessageV2.WithParts | undefined)?.parts.findLast(
              (p): p is Extract<MessageV2.Part, { type: "text" }> => p.type === "text",
            )?.text
      return { finalText, structured }
    })

    const forkWork = (input: {
      sessionID: SessionID
      parentSessionID: SessionID
      parentActorID?: string
      actorID: string
      agentType: string
      task: string
      description?: string
      background: boolean
      model?: { providerID: ProviderID; modelID: ModelID }
      lifecycle: "ephemeral" | "persistent"
      task_id?: string
      // True for non-specialized subagents (those that received
      // RETURN_FORMAT_INSTRUCTION). Only these are subject to the completion
      // gate; specialized/system agents and peers create no user tasks.
      gateEligible?: boolean
      format?: MessageV2.OutputFormat
      // When set, the child's work fiber runs under this InstanceContext (via
      // InstanceRef) instead of inheriting the spawner's. Used by peers placed
      // in their own git worktree so their tools resolve paths/write-boundary
      // against the worktree, not the orchestrator's directory.
      instanceRef?: InstanceContext
    }) =>
      Effect.gen(function* () {
        const outcome = yield* Deferred.make<AgentOutcome>()
        const description = input.description ?? input.agentType
        // Auto-start the bound task: spawning an actor for a task IS that task
        // beginning work. Status transition is a structural side-effect of spawn,
        // not a model action (the model maintains task status unreliably).
        // `done` stays gate/model-driven. Uses parentSessionID because the task
        // lives in the parent/main session, not a peer's child session.
        // ignoreCause (not ignore): TaskRegistry.start raises a missing task_id as
        // a *defect* (Effect.die), which Effect.ignore does NOT swallow — only
        // ignoreCause does. A stale/missing task_id must never block the spawn,
        // but log on swallow so a genuine bug in start() leaves a breadcrumb.
        if (input.task_id) {
          yield* taskRegistry
            .start({ session_id: input.parentSessionID, id: input.task_id, owner: input.actorID })
            .pipe(Effect.ignoreCause({ log: "Warn", message: `auto-start of task ${input.task_id} failed` }))
        }
        const notify = (
          status: "completed" | "failed" | "cancelled",
          extra: { result?: string; error?: string; reportedStatus?: ReturnStatus; reportedSummary?: string },
        ) =>
          // An external cancel masks its own interrupt (runLoop.onInterrupt
          // returns lastAssistant), so this fiber would otherwise emit a bogus
          // "completed"/"failed". Defer to the terminal-status bridge, which
          // emits the single authoritative "cancelled" notification.
          cancelling.has(cancelKey(input.sessionID, input.actorID))
            ? Effect.void
            : input.background && input.agentType !== "checkpoint-writer"
            ? inbox
                .send({
                  receiverSessionID: input.parentSessionID,
                  receiverActorID: input.parentActorID ?? "main",
                  senderSessionID: input.sessionID,
                  senderActorID: input.actorID,
                  type: "actor_notification",
                  content: renderActorNotification({
                    actorID: input.actorID,
                    description,
                    status,
                    ...extra,
                  }),
                })
                .pipe(Effect.ignore)
                // Also give the user a visible signal (the child may be unfocused).
                .pipe(
                  Effect.andThen(
                    Effect.promise(() =>
                      Bus.publish(TuiEvent.ToastShow, {
                        message: `Child "${description}" ${status}`,
                        variant: status === "completed" ? "success" : status === "cancelled" ? "info" : "error",
                      }),
                    ).pipe(Effect.ignore),
                  ),
                )
            : Effect.void

        // Derive actor mode from spawn shape: peer creates a new session, subagent shares parent's
        const actorMode: "peer" | "subagent" = input.parentSessionID === input.sessionID ? "subagent" : "peer"

        // Writability of THIS agent, derived from the same predicate the runtime uses to
        // strip the Write tool (llm.ts resolveTools → Permission.disabled). Read-only agents
        // (e.g. explore: "*":deny) → canWrite=false → postStop progress check is skipped for
        // them (they cannot satisfy a "write the journal" nudge; their findings return via
        // finalText). Agent-static: uses agentInfo.permission ONLY, not the session-merged
        // ruleset resolveTools builds (merge(agent, session)). So canWrite diverges from
        // runtime tool-stripping only under a session-level override — e.g. session "*":allow
        // un-stripping a read-only agent's write (we skip though runtime allows), or session
        // "*":deny on a writable agent (we nudge though runtime strips). Both are deliberately
        // ignored: not reachable in normal usage (mimo run sets no such rule, spawn doesn't
        // rewrite session.permission). See spec §Decision. Unknown agent → fail-open (true).
        const forkAgentInfo = yield* agents.get(input.agentType)
        const canWrite = forkAgentInfo ? !Permission.disabled(["write"], forkAgentInfo.permission).has("write") : true

        const work = Effect.gen(function* () {
          let finalText: string | undefined
          let structured: unknown | undefined
          let iteration = 0
          let lastDecision:
            | { reason: string; contributingPluginNames: string[]; contributingHookIDs: string[] }
            | undefined

          while (true) {
            const reentryDecision = iteration > 0 ? lastDecision : undefined
            const turn = yield* runTurn(
              input.sessionID,
              input.actorID,
              runAgentLoop({
                ...input,
                task: reentryDecision ? reentryDecision.reason : input.task,
                source: reentryDecision ? "hook" : "spawn",
                provenance: reentryDecision
                  ? {
                      hookPhase: "pre",
                      hookIteration: iteration,
                      pluginNames: reentryDecision.contributingPluginNames,
                      hookIDs: reentryDecision.contributingHookIDs,
                    }
                  : undefined,
              }),
            )
            finalText = turn.finalText
            structured = turn.structured

            iteration++
            if (iteration > MAX_PRE_REACT) {
              yield* bus.publish(HookEvent.ReActMaxReached, {
                phase: "pre",
                actorID: input.actorID,
                agentType: input.agentType,
              })
              log.warn("actor.preStop hit MAX_PRE_REACT cap; skipping further hook checks", {
                actorID: input.actorID,
                totalTurns: iteration,
              })
              break
            }

            const decision = yield* plugin.triggerActorPreStop({
              sessionID: input.sessionID,
              parentSessionID: input.parentSessionID,
              actorID: input.actorID,
              parentActorID: input.parentActorID,
              agentType: input.agentType,
              mode: actorMode,
              lifecycle: input.lifecycle,
              finalText,
              task: input.task,
              description: input.description,
              task_id: input.task_id,
              iteration: iteration - 1,
            })
            if (!decision.continue) break
            if (!decision.reason) break // defense-in-depth — T4 invariant guarantees this won't fire

            yield* bus.publish(HookEvent.ReActReentered, {
              phase: "pre",
              actorID: input.actorID,
              agentType: input.agentType,
              iteration,
              triggeredByPlugins: decision.contributingPluginNames,
              reasonPreview: decision.reason.slice(0, 200),
            })

            lastDecision = {
              reason: decision.reason,
              contributingPluginNames: decision.contributingPluginNames,
              contributingHookIDs: decision.contributingHookIDs,
            }
          }

          return { finalText, structured }
        }).pipe(
          Effect.provideService(ActorRegistry.Service, actorReg),
          Effect.matchCauseEffect({
            onSuccess: ({ finalText, structured }) =>
              Effect.gen(function* () {
                // === COMPLETION GATE (B) + structured parse (A) ===
                // Delegates the list/decide step to TaskGate.decide.
                // We retain the runTurn re-entry + delivered-text update here
                // because that is gate-policy, not list-policy.
                let deliveredText = finalText
                if (input.gateEligible) {
                  let gateIter = 0
                  while (true) {
                    const decision = yield* TaskGate.decide({
                      session_id: input.parentSessionID,
                      owner: input.actorID,
                      reactCount: gateIter,
                      maxReact: MAX_TASK_GATE_SUBAGENT_REACT,
                    }).pipe(Effect.provideService(TaskRegistry.Service, taskRegistry))
                    if (!decision.needReentry) break
                    gateIter++
                    const gateTurn = yield* runTurn(
                      input.sessionID,
                      input.actorID,
                      runAgentLoop({
                        ...input,
                        task: decision.reentryText,
                        source: "hook",
                        provenance: { hookPhase: "post", hookIteration: gateIter, pluginNames: [], hookIDs: [] },
                      }),
                    ).pipe(
                      Effect.catch(() =>
                        Effect.gen(function* () {
                          log.error("actor.gate runTurn failed", { actorID: input.actorID })
                          return { finalText: undefined as string | undefined, structured: undefined as unknown }
                        }),
                      ),
                      Effect.provideService(ActorRegistry.Service, actorReg),
                    )
                    // The gate re-run's re-emitted text updates the delivered body
                    // (and structured, if it produced one) so the reconciliation +
                    // delivery below see the latest turn.
                    if (gateTurn.finalText !== undefined) deliveredText = gateTurn.finalText
                    if (gateTurn.structured !== undefined) structured = gateTurn.structured
                  }
                }

                // Reconcile: DB truth wins over the model's self-reported header.
                const remaining = input.gateEligible
                  ? yield* taskRegistry
                      .list({ session_id: input.parentSessionID, owner: input.actorID, include_terminal: false })
                      .pipe(Effect.orElseSucceed(() => []))
                  : []
                const stillActionable = remaining.filter((t) => t.status === "open" || t.status === "in_progress")
                const downgrade: ReturnStatus | undefined =
                  stillActionable.length > 0 ? "partial" : remaining.length > 0 ? "blocked" : undefined
                const parsed = parseReturnHeader(deliveredText)
                const reportedStatus = downgrade ?? parsed.status
                const incompleteTasks = remaining.map((t) => t.id)
                const reconciledText =
                  downgrade && incompleteTasks.length > 0
                    ? `${deliveredText ?? ""}\n\n**Incomplete tasks**: ${incompleteTasks.join(", ")}`
                    : deliveredText

                // === DELIVERY ===
                // structured (json_schema result) takes precedence over text for the
                // notification body (DW spec P3 §5.2); otherwise deliver the gate's
                // reconciled text. The success outcome carries both the reconciled
                // text + completion-gate fields AND structured when present.
                const deliveryText =
                  structured !== undefined ? JSON.stringify(structured) : (reconciledText ?? "(no output)")
                yield* notify("completed", {
                  result: deliveryText,
                  ...(reportedStatus ? { reportedStatus } : {}),
                  ...(parsed.summary ? { reportedSummary: parsed.summary } : {}),
                })
                yield* Deferred.succeed(outcome, {
                  status: "success" as const,
                  ...(reconciledText !== undefined ? { finalText: reconciledText } : {}),
                  ...(structured !== undefined ? { structured } : {}),
                  ...(reportedStatus ? { reportedStatus } : {}),
                  ...(parsed.summary ? { reportedSummary: parsed.summary } : {}),
                  ...(incompleteTasks.length > 0 ? { incompleteTasks } : {}),
                })

                // === postStop ReAct loop ===
                // Caller has already resolved; new finalTexts are not propagated.
                // NOTE: parallel structure to preStop loop above — pre runs turn THEN checks,
                // post checks THEN runs turn. Both give 1 (delivery) + MAX_POST_REACT re-entries.
                let postIter = 0
                let lastFinalText = finalText
                let postReentry:
                  | { reason: string; contributingPluginNames: string[]; contributingHookIDs: string[] }
                  | undefined

                while (true) {
                  const decision = yield* plugin.triggerActorPostStop({
                    sessionID: input.sessionID,
                    parentSessionID: input.parentSessionID,
                    actorID: input.actorID,
                    parentActorID: input.parentActorID,
                    agentType: input.agentType,
                    mode: actorMode,
                    lifecycle: input.lifecycle,
                    finalText: lastFinalText,
                    task: input.task,
                    description: input.description,
                    task_id: input.task_id,
                    outcome: "success",
                    iteration: postIter,
                    canWrite,
                  })

                  if (!decision.continue) break
                  if (!decision.reason) break // defense-in-depth
                  if (postIter >= MAX_POST_REACT) {
                    yield* bus.publish(HookEvent.ReActMaxReached, {
                      phase: "post",
                      actorID: input.actorID,
                      agentType: input.agentType,
                    })
                    log.warn("actor.postStop hit MAX_POST_REACT cap; skipping further hook checks", {
                      actorID: input.actorID,
                      totalTurns: postIter + 1,
                    })
                    break
                  }
                  postIter++

                  yield* bus.publish(HookEvent.ReActReentered, {
                    phase: "post",
                    actorID: input.actorID,
                    agentType: input.agentType,
                    iteration: postIter,
                    triggeredByPlugins: decision.contributingPluginNames,
                    reasonPreview: decision.reason.slice(0, 200),
                  })

                  postReentry = {
                    reason: decision.reason,
                    contributingPluginNames: decision.contributingPluginNames,
                    contributingHookIDs: decision.contributingHookIDs,
                  }

                  // Run another turn (new finalText is not written back to outcome)
                  const newTurn = yield* runTurn(
                    input.sessionID,
                    input.actorID,
                    runAgentLoop({
                      ...input,
                      task: postReentry.reason,
                      source: "hook",
                      provenance: {
                        hookPhase: "post",
                        hookIteration: postIter,
                        pluginNames: postReentry.contributingPluginNames,
                        hookIDs: postReentry.contributingHookIDs,
                      },
                    }),
                  ).pipe(
                    // postStop LLM failure: log + break loop, do NOT propagate
                    Effect.catch(() =>
                      Effect.gen(function* () {
                        log.error("actor.postStop runTurn failed", {
                          actorID: input.actorID,
                        })
                        return { finalText: undefined as string | undefined, structured: undefined as unknown }
                      }),
                    ),
                    Effect.provideService(ActorRegistry.Service, actorReg),
                  )

                  if (newTurn.finalText === undefined) break
                  lastFinalText = newTurn.finalText
                }

                yield* Effect.sync(() => forkContexts.delete(input.actorID))
              }),
            onFailure: (cause) =>
              Effect.gen(function* () {
                const cancelled = Cause.hasInterruptsOnly(cause)
                const error = Cause.pretty(cause)
                yield* notify(cancelled ? "cancelled" : "failed", cancelled ? {} : { error })
                yield* Deferred.succeed(
                  outcome,
                  cancelled ? { status: "cancelled" as const } : { status: "failure" as const, error },
                )
                yield* Effect.sync(() => forkContexts.delete(input.actorID))
              }),
          }),
        )
        const boundWork = input.instanceRef
          ? work.pipe(Effect.provideService(InstanceRef, input.instanceRef))
          : work
        const fiber = yield* boundWork.pipe(Effect.forkIn(scope))
        return { fiber, outcome }
      })

    const spawnPeer = Effect.fn("Actor.spawnPeer")(function* (input: SpawnInput) {
      // When the caller gives the child its own directory (e.g. a worktree the
      // session tool created), bind the child's work fiber to that directory's
      // Instance so its file tools / write boundary are isolated there. A
      // worktree is just a directory — spawn neither knows nor cares how it was
      // made. Best-effort: a bad/unresolvable dir falls back to the shared dir.
      const instanceRef = input.cwd
        ? yield* Effect.promise(() => Instance.provide({ directory: input.cwd!, fn: () => Instance.current })).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
        : undefined

      const child = yield* session.create({
        parentID: input.sessionID,
        contextFrom: input.context === "full" ? input.sessionID : undefined,
        title: `${input.agentType}: ${input.task.slice(0, 40)}`,
        ...(input.cwd ? { directory: input.cwd } : {}),
      })
      // T42: register the peer's receiver/actor-registry row (session_id ===
      // actor_id === child.id, mode "peer") SYNCHRONOUSLY here — before spawn
      // resolves and before the child's first turn. This is the single
      // spawn-time registration that makes a child addressable the instant
      // `session create` returns: Inbox.send's ESRCH pre-check (reg.get) and
      // `session send` both resolve against this row without waiting for the
      // child to arm anything on its first turn. turn_count/status start at 0/
      // "pending"; the per-step turn heartbeat (registry.updateTurn) advances
      // them later. No double-registration: nothing on the first-turn path
      // (prompt.ts) re-registers a peer — it only reads (reg.get) and updates
      // (updateTurn/updateStatus). Prerequisite for T43 (--topic reuse).
      yield* actorReg.register({
        sessionID: child.id,
        actorID: child.id,
        mode: "peer",
        parentActorID: input.parentActorID,
        agent: input.agentType,
        description: input.description ?? input.agentType,
        contextMode: input.context,
        contextWatermark: undefined,
        background: input.background,
        lifecycle: input.lifecycle ?? "persistent",
        tools: input.tools,
      })
      if (input.forkContext) {
        forkContexts.set(child.id, input.forkContext) // peer's actorID === child.id
      }
      const { fiber, outcome } = yield* forkWork({
        sessionID: child.id,
        parentSessionID: input.sessionID,
        parentActorID: input.parentActorID,
        actorID: child.id,
        agentType: input.agentType,
        task: input.task,
        description: input.description,
        background: input.background,
        model: input.model,
        lifecycle: input.lifecycle ?? "persistent",
        task_id: input.task_id,
        format: input.format,
        ...(instanceRef ? { instanceRef } : {}),
      })
      if (!input.background) yield* Fiber.join(fiber).pipe(Effect.ignore)
      return { actorID: child.id, sessionID: child.id, outcome }
    })

    const spawnSubagent = Effect.fn("Actor.spawnSubagent")(function* (input: SpawnInput) {
      const actorID = yield* actorReg.allocateActorID(input.sessionID, input.agentType)

      const watermark = input.context === "full" ? yield* session.lastMainMessageID(input.sessionID) : undefined

      yield* actorReg.register({
        sessionID: input.sessionID,
        actorID,
        mode: "subagent",
        parentActorID: input.parentActorID,
        agent: input.agentType,
        description: input.description ?? input.agentType,
        contextMode: input.context,
        contextWatermark: watermark,
        background: input.background,
        lifecycle: input.lifecycle ?? "ephemeral",
        tools: input.tools,
      })

      // The actor now EXISTS in the registry. Hand the caller its id before the
      // work fiber detaches below, so a concurrent reclaim can see it (MR104 #2).
      // Synchronous + best-effort: a throwing callback must not fail the spawn.
      if (input.onActorID) yield* Effect.sync(() => input.onActorID!(actorID)).pipe(Effect.ignore)

      if (input.forkContext) {
        forkContexts.set(actorID, input.forkContext)
      }

      // Auto-inject return-format instruction for non-specialized subagents.
      // Excluded: agents with hardcoded `prompt` (explore/title/summary — own
      // contracts), checkpoint-writer (special — task is itself a complete
      // writer-instruction string), and peer mode (routes via spawnPeer).
      const agentInfo = yield* agents.get(input.agentType)
      const gateEligible =
        agentInfo?.mode === "subagent" && !agentInfo?.prompt && input.agentType !== "checkpoint-writer"
      const taskWithFormat = gateEligible ? input.task + RETURN_FORMAT_INSTRUCTION : input.task

      const { fiber, outcome } = yield* forkWork({
        sessionID: input.sessionID,
        parentSessionID: input.parentSessionID ?? input.sessionID,
        parentActorID: input.parentActorID,
        actorID,
        agentType: input.agentType,
        task: taskWithFormat,
        description: input.description,
        background: input.background,
        model: input.model,
        lifecycle: input.lifecycle ?? "ephemeral",
        task_id: input.task_id,
        gateEligible,
        format: input.format,
      })
      if (input.onReady) yield* Effect.ignore(input.onReady({ actorID, sessionID: input.sessionID }))
      if (!input.background) yield* Fiber.join(fiber).pipe(Effect.ignore)
      return { actorID, sessionID: input.sessionID, outcome }
    })

    const spawn = Effect.fn("Actor.spawn")(function* (input: SpawnInput) {
      if (input.mode === "peer") return yield* spawnPeer(input)
      return yield* spawnSubagent(input)
    })

    // === Unified terminal notification (T41) ===
    // Single parent-notification contract for a terminal outcome. Completion and
    // failure already notify directly from forkWork.notify on the woken/spawn
    // turn; a CANCELLED child cannot, because its interrupt is masked by the
    // runLoop.onInterrupt handler (returns lastAssistant) so the work fiber sees
    // a spurious "success" and its own notify is suppressed via the `cancelling`
    // set. `cancel` therefore emits the one authoritative cancelled notification
    // here, reusing the exact shape forkWork.notify uses (renderActorNotification
    // + actor_notification inbox message + a TUI toast). Gating (background,
    // non-system peer/subagent) matches forkWork.notify so cancel/success/fail
    // stay a single contract with no double-notify. Best-effort: a missing row
    // or unresolved parent silently no-ops.
    const notifyTerminal = (
      sessionID: SessionID,
      actorID: string,
      actor: Actor | undefined,
      status: "cancelled",
    ) =>
      Effect.gen(function* () {
        if (!actor) return
        if (!actor.background) return
        if (actor.mode !== "peer" && actor.mode !== "subagent") return
        if (SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent)) return
        // Resolve the parent session: a peer runs in its own child session (notify
        // its parentID); a subagent shares the parent's session.
        const parentSessionID =
          actor.mode === "peer" ? (yield* session.get(sessionID)).parentID : sessionID
        if (!parentSessionID) return
        yield* inbox
          .send({
            receiverSessionID: parentSessionID,
            receiverActorID: actor.parentActorID ?? "main",
            senderSessionID: sessionID,
            senderActorID: actorID,
            type: "actor_notification",
            content: renderActorNotification({
              actorID,
              description: actor.description,
              status,
            }),
          })
          .pipe(Effect.ignore)
        yield* Effect.promise(() =>
          Bus.publish(TuiEvent.ToastShow, {
            message: `Child "${actor.description}" ${status}`,
            variant: "info",
          }),
        ).pipe(Effect.ignore)
      }).pipe(Effect.catchCause((cause) => Effect.logError(`terminal notify failed: ${cause}`)))

    const cancel: (sessionID: SessionID, actorID: string, mode: "graceful" | "forced") => Effect.Effect<void> =
      Effect.fn("Actor.cancel")(function* (sessionID: SessionID, actorID: string, mode: "graceful" | "forced") {
        const children = yield* actorReg.listByParent(sessionID, actorID)
        yield* Effect.forEach(children, (c) => cancel(sessionID, c.actorID, mode), {
          concurrency: "unbounded",
          discard: true,
        })
        // Mark cancelling BEFORE interrupting so forkWork.notify (which fires on
        // the interrupt-masked "success") suppresses its own emit; the single
        // authoritative "cancelled" notification is emitted below instead.
        yield* Effect.sync(() => cancelling.add(cancelKey(sessionID, actorID)))
        // Snapshot the actor row before cancelActor tears state down — we need
        // its mode/agent/background/parentActorID to decide + address the notify.
        const actor = yield* actorReg.get(sessionID, actorID)
        yield* state.cancelActor(sessionID, actorID)
        yield* actorReg
          .updateStatus(sessionID, actorID, { status: "idle", lastOutcome: "cancelled" })
          .pipe(Effect.ignore)
        yield* notifyTerminal(sessionID, actorID, actor, "cancelled")
        yield* Effect.sync(() => forkContexts.delete(actorID))
      })

    const getForkContext = Effect.fn("Actor.getForkContext")(function* (actorID: string) {
      return forkContexts.get(actorID)
    })

    // === T40 stall watchdog ===
    // Event-driven stall detection: a background fiber periodically scans active
    // background actors (ActorRegistry.listActive → pending/running + background),
    // computes deriveLiveness for each, and when a PEER/subagent flips to
    // `stalled` (running/pending but now-lastTurnTime > DEFAULT_LIVENESS_STALL_MS
    // AND turnCount not advancing — deriveLiveness encodes exactly that) pushes
    // ONE actor_notification{stalled} to its parent. Reuses the notifyTerminal
    // shape (inbox.send actor_notification + renderActorNotification + a TUI
    // toast) so stalled joins completed/failed/cancelled on one contract.
    //
    // Debounce — the crux: `notified` holds the "sessionID:actorID" of actors we
    // have ALREADY warned about for their CURRENT stall episode. We emit only on
    // the not-yet-notified → stalled edge; while it STAYS stalled across ticks it
    // is in `notified` and we skip. We re-arm (delete the key) the moment the
    // actor is no longer stalled — it resumed (turnCount advanced so
    // deriveLiveness reads `progressing`), went terminal, or vanished — so a
    // later re-stall notifies again. One notification per stall episode.
    const notified = new Set<string>()

    // Emit the single stalled notification for one actor. Same gating +
    // parent-resolution as notifyTerminal: background only, peer/subagent only,
    // exclude SYSTEM_SPAWNED_AGENT_TYPES, address the parent's main inbox.
    const notifyStalled = (actor: Actor, stalledForMs: number) =>
      Effect.gen(function* () {
        if (!actor.background) return
        if (actor.mode !== "peer" && actor.mode !== "subagent") return
        if (SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent)) return
        const parentSessionID =
          actor.mode === "peer" ? (yield* session.get(actor.sessionID)).parentID : actor.sessionID
        if (!parentSessionID) return
        yield* inbox
          .send({
            receiverSessionID: parentSessionID,
            receiverActorID: actor.parentActorID ?? "main",
            senderSessionID: actor.sessionID,
            senderActorID: actor.actorID,
            type: "actor_notification",
            content: renderActorNotification({
              actorID: actor.actorID,
              description: actor.description,
              status: "stalled",
              stalledForMs,
            }),
          })
          .pipe(Effect.ignore)
        yield* bus
          .publish(ActorEvents.ActorStalled, {
            sessionID: actor.sessionID,
            actorID: actor.actorID,
            description: actor.description,
            lastTurnTime: actor.lastTurnTime,
            stalledDuration: stalledForMs,
          })
          .pipe(Effect.ignore)
        yield* Effect.promise(() =>
          Bus.publish(TuiEvent.ToastShow, {
            message: `Child "${actor.description}" appears stalled`,
            variant: "info",
          }),
        ).pipe(Effect.ignore)
      }).pipe(Effect.catchCause((cause) => Effect.logError(`stall notify failed: ${cause}`)))

    const scanStalled = Effect.gen(function* () {
      const now = Date.now()
      const active = yield* actorReg.listActive().pipe(Effect.orElseSucceed(() => [] as Actor[]))
      const seen = new Set<string>()
      for (const actor of active) {
        const key = `${actor.sessionID}:${actor.actorID}`
        seen.add(key)
        const live = deriveLiveness(actor, now)
        if (live === "stalled") {
          if (notified.has(key)) continue // already warned this episode — debounce
          notified.add(key)
          yield* notifyStalled(actor, now - actor.lastTurnTime)
          continue
        }
        // Not stalled (progressing/terminal) → re-arm so a future re-stall notifies.
        notified.delete(key)
      }
      // Drop debounce keys for actors that fell out of listActive entirely
      // (went terminal / row gone) so the set can't grow unbounded and a
      // recycled id re-arms cleanly.
      for (const key of notified) if (!seen.has(key)) notified.delete(key)
    }).pipe(Effect.catchCause((cause) => Effect.logError(`stall watchdog scan failed: ${cause}`)))

    // Fork the watchdog into the instance (layer) scope. CRITICAL (T41 lesson):
    // once the fiber detaches, Instance.current ALS context is lost, so
    // actorReg.listActive / inbox.send → Database.use → Client() →
    // InstanceState.bind would throw NotFound(instance). We capture the instance
    // context that is ALS-bound HERE at layer-build time and re-provide it via
    // InstanceRef, whose fallback path InstanceState.bind reads off the fiber
    // context. `undefined` (no instance at build, e.g. some test harnesses) is a
    // safe no-op — Database.use then takes its own NotFound fallback.
    const watchdogInstance = yield* Effect.sync(() => {
      try {
        return Instance.current
      } catch {
        return undefined
      }
    })
    yield* scanStalled.pipe(
      Effect.repeat(Schedule.spaced(WATCHDOG_SCAN_INTERVAL_MS)),
      Effect.provideService(InstanceRef, watchdogInstance),
      Effect.ignore,
      Effect.forkIn(scope),
    )

    const impl = Service.of({ spawn, cancel, getForkContext, scanStalledOnce: () => scanStalled })
    // Late-bind the impl so SessionCheckpoint.tryStartCheckpointWriter can resolve it
    // without forming a layer cycle. See spawn-ref.ts for rationale.
    // Save the previous binding so the finalizer can restore it: when the same
    // process initialises Actor.layer more than once (memo'd ManagedRuntimes,
    // overlapping test runtimes, etc.) the inner scope's dispose must hand
    // control back to the outer scope's impl instead of wiping the ref to
    // `undefined` and breaking every subsequent tryStartCheckpointWriter call.
    const prevSpawnRef = spawnRef.current
    spawnRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (spawnRef.current === impl) spawnRef.current = prevSpawnRef
      }),
    )
    return impl
  }),
)

// Wrapped in Layer.suspend so the cross-module `.defaultLayer` reads defer to
// first use instead of running at module load. Without this, the
// spawn → prompt → app-runtime import cycle hits a load order where
// AppLayer's mergeAll runs while SessionPrompt is mid-init and throws
// "Cannot access 'defaultLayer' before initialization", breaking every
// it.live test harness. Same pattern session/prompt, session/checkpoint,
// tool/registry, provider, etc. already use.
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(SessionPrompt.defaultLayer),
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Inbox.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(TaskRegistry.defaultLayer),
  ),
)

export * as Actor from "./spawn"
