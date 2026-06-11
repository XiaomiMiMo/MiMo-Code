import { Effect, Deferred, Context, Fiber, Layer, Scope, Cause } from "effect"
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
import type { SpawnMode, ContextMode, ToolWhitelist, Lifecycle } from "@/actor/schema"
import { runTurn } from "@/actor/turn"
import { spawnRef } from "@/actor/spawn-ref"
import { Bus } from "@/bus"
import { MessageV2 } from "@/session/message-v2"
import { Inbox } from "@/inbox"
import { renderActorNotification } from "@/inbox/render"
import { Plugin, HookEvent } from "@/plugin"
import { parseReturnHeader, type ReturnStatus } from "./return-header"
import { Log } from "@/util"

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
          input.background && input.agentType !== "checkpoint-writer"
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
                // Delegates the list/decide step to TaskGate.decide so the
                // logic is shared with the main-session taskGate (prompt.ts).
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
                      mode: "subagent",
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
        const fiber = yield* work.pipe(Effect.forkIn(scope))
        return { fiber, outcome }
      })

    const spawnPeer = Effect.fn("Actor.spawnPeer")(function* (input: SpawnInput) {
      const child = yield* session.create({
        parentID: input.sessionID,
        contextFrom: input.context === "full" ? input.sessionID : undefined,
        title: `${input.agentType}: ${input.task.slice(0, 40)}`,
      })
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
      if (!input.background) yield* Fiber.join(fiber).pipe(Effect.ignore)
      return { actorID, sessionID: input.sessionID, outcome }
    })

    const spawn = Effect.fn("Actor.spawn")(function* (input: SpawnInput) {
      if (input.mode === "peer") return yield* spawnPeer(input)
      return yield* spawnSubagent(input)
    })

    const cancel: (sessionID: SessionID, actorID: string, mode: "graceful" | "forced") => Effect.Effect<void> =
      Effect.fn("Actor.cancel")(function* (sessionID: SessionID, actorID: string, mode: "graceful" | "forced") {
        const children = yield* actorReg.listByParent(sessionID, actorID)
        yield* Effect.forEach(children, (c) => cancel(sessionID, c.actorID, mode), {
          concurrency: "unbounded",
          discard: true,
        })
        yield* state.cancelActor(sessionID, actorID)
        yield* actorReg
          .updateStatus(sessionID, actorID, { status: "idle", lastOutcome: "cancelled" })
          .pipe(Effect.ignore)
        yield* Effect.sync(() => forkContexts.delete(actorID))
      })

    const getForkContext = Effect.fn("Actor.getForkContext")(function* (actorID: string) {
      return forkContexts.get(actorID)
    })

    const impl = Service.of({ spawn, cancel, getForkContext })
    // Late-bind the impl so SessionCheckpoint.tryStartCheckpointWriter can resolve it
    // without forming a layer cycle. See spawn-ref.ts for rationale.
    spawnRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (spawnRef.current === impl) spawnRef.current = undefined
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
