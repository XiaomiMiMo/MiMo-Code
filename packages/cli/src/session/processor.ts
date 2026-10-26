import { Cause, Deferred, Effect, Exit, Fiber, Layer, Context, Scope } from "effect"
import * as Stream from "effect/Stream"
import { Agent, resolveStoredAgent } from "@/agent/agent"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"
import { Bus } from "@/bus"
import { Metrics } from "@/metrics"
import { Config } from "@/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { classifyAssistantStep } from "./classify"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { ProviderError } from "@/provider"
import type { Provider } from "@/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { ToolGate, FAIL_CASCADE_MESSAGE } from "@/tool/gate"
import { ResultRef } from "@/tool/settlement"
import { isRecoverableError } from "@/tool/recoverable"
import { getToolResultAttachments, getToolResultMetadata } from "@/tool/result-error"
import { Log } from "@/util"
import { isRecord } from "@/util/record"
import { createTextNgramMonitor, type TextNgramMonitor } from "./prompt/text-ngram-detection"
import { Flag } from "@/flag/flag"
import { MCP_TOOL_USE_ID } from "@/tool/mcp-tool-search"
import { monitor as tryBestMonitor, type TryBestIncident } from "./try-best-detector"

const DOOM_LOOP_THRESHOLD = 3
const log = Log.create({ service: "session.processor" })

// A dispatched MCP call reports under the MCP tool it ran, matching the
// success metric published by the MCP execution pipeline.
function metricToolName(toolName: string, input: unknown) {
  if (toolName !== MCP_TOOL_USE_ID || !isRecord(input) || typeof input.name !== "string") return toolName
  return input.name
}

function isToolExecutionResult(output: unknown): output is {
  title: string
  metadata: Record<string, any>
  output: string
  attachments?: MessageV2.FilePart[]
} {
  return (
    isRecord(output) &&
    typeof output.title === "string" &&
    isRecord(output.metadata) &&
    typeof output.output === "string"
  )
}

function displayToolOutput(output: unknown) {
  if (typeof output === "string") return output
  return JSON.stringify(output, null, 2) ?? String(output)
}

function jsonToolOutput(output: unknown): MessageV2.ToolStateCompleted["providerOutput"] {
  const serialized = JSON.stringify(output)
  return serialized === undefined ? null : JSON.parse(serialized)
}

function describeTryBest(incident: TryBestIncident) {
  if (incident.reason === "edit_repeat") {
    return `A near-identical edit to ${incident.evidence.path ?? "the same file"} repeated ${incident.evidence.count} times.`
  }
  if (incident.reason === "bash_retry") {
    return `The same failing command was retried ${incident.evidence.count} times without an intervening successful edit.`
  }
  return `${incident.evidence.count} consecutive ${incident.evidence.action ?? "same-kind"} actions made no observable progress.`
}

export type Result = "overflow" | "stop" | "continue" | "text-repeat" | "superseded"

export type Event = LLM.Event

/**
 * Codex-style auto-resume gate: after tools have fully completed, a retryable
 * transport failure should continue the outer step (tool results stay in
 * history) instead of stamping a terminal error. Replaying this stream is
 * unsafe; the next sampling call is not.
 */
export function shouldAutoResumeAfterTools(input: {
  retrySafe: boolean
  decision: { retryable: boolean }
  toolParts: readonly { state: { status: string } }[]
  /** User/agent abort — never reopen the step. */
  aborted?: boolean
  /** Current assistant finish reason (provider). Terminal reasons must not be rewritten. */
  finish?: string | undefined
  /** Non-empty user-visible final text already on this assistant message. */
  hasFinalText?: boolean
}): boolean {
  if (input.aborted) return false
  if (input.retrySafe) return false
  if (!input.decision.retryable) return false
  // Already-delivered answer: finish=stop/other (or content-filter/error) is terminal.
  // Overwriting it to "tool-calls" reopens a finished turn and the runLoop never idles
  // (classify keeps returning continue on the completed tools). Trailing transport
  // noise after a good final must leave the answer intact.
  if (input.finish === "stop" || input.finish === "other") {
    if (input.hasFinalText) return false
  }
  if (input.finish === "content-filter" || input.finish === "error") return false
  const hasCompleted = input.toolParts.some((p) => p.state.status === "completed")
  const hasInFlight = input.toolParts.some((p) => p.state.status === "running" || p.state.status === "pending")
  return hasCompleted && !hasInFlight
}

/**
 * A proposed tool call captured from a candidate stream (max mode), before
 * any execution. `input` is the parsed tool arguments.
 */
export type ProposedToolCall = {
  toolCallId: string
  toolName: string
  input: Record<string, any>
  providerMetadata?: Record<string, any>
}

/**
 * The winning candidate selected by the judge in max mode. Captures the full
 * reasoning + text + proposed tool calls of one candidate stream so the
 * processor can replay it: lay down the reasoning/text parts and actually
 * execute the tool calls via the execute-bearing tools.
 */
export type ReplayInput = {
  reasoning?: string
  reasoningMetadata?: Record<string, any>
  text?: string
  textMetadata?: Record<string, any>
  toolCalls: ProposedToolCall[]
  finishReason: string
  usage?: any
  providerMetadata?: Record<string, any>
  /** Execute-bearing tools (from resolveTools) used to run the winner's calls. */
  tools: Record<string, { execute?: (input: any, options: any) => Promise<any> }>
  /** Model messages passed to tool execute contexts. */
  messages: any[]
  /**
   * Max-mode selection metadata. When set, a short note is prepended to the
   * replayed reasoning so the user can see the ensemble happened and which
   * candidate won. `winner` is 0-based.
   */
  selection?: { winner: number; total: number }
  /**
   * Real wall-clock duration (ms) the winning candidate spent thinking, so the
   * replayed reasoning part shows a meaningful duration instead of the ~1ms
   * synthetic replay time. Optional.
   */
  thinkingMs?: number
  /**
   * Max-mode ensemble overhead: the cost and token counts of the losing
   * candidates + the judge call. These are real spend but consume NO context,
   * so they are added to `cost` and the ModelCall metric ONLY — never to the
   * message's `tokens`, which must stay the winner's real footprint so context
   * overflow / prune estimation stays correct.
   */
  overhead?: { cost: number; tokensIn: number; tokensOut: number }
}

export interface Handle {
  readonly toolGate: ToolGate
  readonly registerTool: (name: string) => void
  readonly executeTool: <A, E, R>(
    tool: string,
    callID: string,
    body: Effect.Effect<A, E, R>,
    options?: { signal?: AbortSignal; gateTool?: string },
  ) => Effect.Effect<A, E | Error, R>
  readonly message: MessageV2.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: unknown,
    providerMetadata?: Record<string, any>,
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  /**
   * Replay a pre-selected candidate (max mode): synthesize the stream events a
   * real model call would have produced for the winner — reasoning, text, then
   * each tool call (input-start → call → execute → result) — and run them
   * through the same event handler used by `process`. Tool execution, snapshot
   * tracking, permission asks and metrics are all reused. Returns the same
   * Result contract as `process`.
   */
  readonly replay: (input: ReplayInput) => Effect.Effect<Result>
}

export type AgentMetrics = {
  tokens_in: number
  tokens_out: number
  files_changed: number
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
  agentMetrics?: AgentMetrics
  /**
   * Completes once a newer input waits in this agent's inbox lane. While the step
   * is retrying a failure, that input supersedes the step so the run loop can
   * claim it instead of holding it behind a persistent retry.
   */
  awaitNewInput?: Effect.Effect<void>
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsOverflowHandling: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
  stepStartedAt: number | undefined
  firstTokenAt: number | undefined
  stepPartIds: PartID[]
  textNgramMonitor: TextNgramMonitor | undefined
  textNgramRepeat: boolean
  textPartPersisted: boolean
  retrySafe: boolean
  /** First provider frame of this process() already marked busy; later retry frames must not clobber session.status{retry}. */
  startedBusy: boolean
  /** Durable retry record of this assistant message; survives retry cleanup, never part of stepPartIds. */
  retryPart: MessageV2.RetryPart | undefined
  /** A retry was recorded in this process() and no attempt has produced output since. */
  retrying: boolean
  /** Completed by the next recorded retry; set while a newer input waits for the step to start failing. */
  retryWaiter: Deferred.Deferred<void> | undefined
  /** The step gave way to a newer input; its interruption is not a user abort. */
  superseded: boolean
}

type StreamEvent = Event

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Session.Service
  | Config.Service
  | Bus.Service
  | Snapshot.Service
  | Agent.Service
  | LLM.Service
  | Permission.Service
  | Plugin.Service
  | SessionSummary.Service
  | SessionStatus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const toolGate = new ToolGate()
      let toolScope = yield* Scope.make()
      let toolsClosed = false
      const closeTools = () => Effect.gen(function* () {
        toolsClosed = true
        yield* Scope.close(toolScope, Exit.void)
      })
      const localTools = new Set<string>()
      const ready = new Map<string, Deferred.Deferred<void>>()
      const toolReady = (callID: string) => {
        let value = ready.get(callID)
        if (!value) {
          value = Deferred.makeUnsafe<void>()
          ready.set(callID, value)
        }
        return value
      }
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        agentMetrics: input.agentMetrics,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsOverflowHandling: false,
        currentText: undefined,
        reasoningMap: {},
        stepStartedAt: undefined,
        firstTokenAt: undefined,
        stepPartIds: [],
        textNgramMonitor: undefined,
        textNgramRepeat: false,
        textPartPersisted: false,
        retrySafe: true,
        startedBusy: false,
        retryPart: undefined,
        retrying: false,
        retryWaiter: undefined,
        superseded: false,
      }
      let aborted = false
      // Only the main agent owns session-level status. Subagents (explore,
      // general, checkpoint-writer, etc.) share the parent sessionID but their
      // run-state onIdle deliberately does NOT reset status (run-state.ts) — so
      // if a subagent's stream sets session status here, nothing ever clears it
      // and the TUI spinner stays spinning after the main agent has finished.
      const isMain = !ctx.assistantMessage.agentID || ctx.assistantMessage.agentID === "main"
      const slog = log.clone().tag("session.id", input.sessionID).tag("messageID", input.assistantMessage.id)

      // Every actor records its retries on its own assistant message, so the
      // record is visible for subagents too and survives reloads until the turn
      // succeeds. Max-mode candidate/judge retries are not the user-visible step.
      const recordRetry = Effect.fn("SessionProcessor.recordRetry")(function* (info: {
        phase: MessageV2.RetryPart["phase"]
        scope: SessionRetry.RetryScope
        kind: SessionRetry.RetryKind
        message: string
        hostCode?: string
        next: number
      }) {
        if (info.scope !== "request" && info.scope !== "live-step") return
        if (info.kind === "terminal") return
        const existing = ctx.retryPart ??
          MessageV2.parts(ctx.assistantMessage.id).find((part): part is MessageV2.RetryPart => part.type === "retry")
        const now = Date.now()
        ctx.retryPart = yield* session.updatePart({
          id: existing?.id ?? PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.sessionID,
          type: "retry",
          attempt: (existing?.attempt ?? 0) + 1,
          phase: info.phase,
          scope: info.scope,
          kind: info.kind,
          message: info.message,
          ...(info.hostCode ? { hostCode: info.hostCode } : {}),
          next: info.next,
          time: { created: existing?.time.created ?? now, updated: now },
        } satisfies MessageV2.RetryPart)
        ctx.retrying = true
        if (ctx.retryWaiter) yield* Deferred.succeed(ctx.retryWaiter, undefined)
      })

      const parse = (e: unknown) =>
        MessageV2.fromLiveError(e, {
          providerID: input.model.providerID,
          aborted,
          allow404Retry: ProviderError.allowsModelNotFoundRetry(input.model),
        })

      const tryBestConfig = (yield* config.get()).experimental?.try_best
      const tryBest = Flag.MIMOCODE_ENABLE_TRY_BEST_HANDOFF
        ? tryBestMonitor(input.sessionID, input.assistantMessage.agentID, tryBestConfig)
        : undefined

      const detectTryBest = Effect.fn("SessionProcessor.detectTryBest")(function* (part: MessageV2.ToolPart) {
        if (ctx.blocked) return
        const incident = tryBest?.consume(part)
        if (!incident) return
        tryBest?.reset()
        ctx.blocked = true
        const detail = describeTryBest(incident)
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.sessionID,
          type: "text",
          text: `Try-best loop detected; this turn was paused. ${detail}`,
          synthetic: true,
          metadata: {
            origin: {
              kind: "try_best",
              providerID: input.model.providerID,
              modelID: input.model.id,
              incident,
            },
          },
          time: { start: Date.now(), end: Date.now() },
        })
        yield* bus.publish(Session.Event.TryBestDetected, {
          sessionID: ctx.sessionID,
          agentID: ctx.assistantMessage.agentID,
          providerID: input.model.providerID,
          modelID: input.model.id,
          ...incident,
        })
        yield* bus
          .publish(Metrics.TryBestDetected, {
            sessionID: ctx.sessionID,
            reason: incident.reason,
            provider: input.model.providerID,
            model_id: input.model.id,
            count: incident.evidence.count,
            similarity: incident.evidence.similarity,
            action: incident.evidence.action,
          })
          .pipe(Effect.ignore)
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        return yield* session.mutateToolPart(call, (part) => part ? update(part) : undefined)
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: unknown,
        providerMetadata?: Record<string, any>,
      ) {
        const result = isToolExecutionResult(output) ? output : undefined
        let changed = false
        const part = yield* updateToolCall(toolCallID, (current) => {
          if (current.state.status !== "running") return current
          changed = true
          const structured = !result && current.metadata?.providerExecuted
          return {
            ...current,
            state: {
              status: "completed",
              input: current.state.input,
              output: result?.output ?? displayToolOutput(output),
              ...(structured ? { providerOutput: jsonToolOutput(output) } : {}),
              ...(providerMetadata ? { providerMetadata } : {}),
              metadata: result?.metadata ?? {},
              title: result?.title ?? "",
              time: { start: current.state.time.start, end: Date.now() },
              attachments: result?.attachments,
            },
          }
        })
        if (!part || !changed) return
        yield* detectTryBest(part)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        let changed = false
        // Agent-recoverable failures (bad args, malformed call, unknown task/actor
        // id) carry a marker the TUI reads to render them muted instead of as a red
        // error block. The full actionable message still flows to the model.
        const recoverable = isRecoverableError(error)
        const metadata = {
          ...getToolResultMetadata(error),
          ...(recoverable ? { recoverable: true } : {}),
        }
        const attachments = getToolResultAttachments(error)?.flatMap((attachment) => {
          const parsed = MessageV2.FilePart.safeParse(attachment)
          return parsed.success ? [parsed.data] : []
        })
        const part = yield* updateToolCall(toolCallID, (current) => {
          if (current.state.status !== "running") return current
          changed = true
          return {
            ...current,
            state: {
              status: "error",
              input: current.state.input,
              inputComplete: true,
              error: errorMessage(error),
              metadata: { ...current.state.metadata, ...metadata },
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
              time: { start: current.state.time.start, end: Date.now() },
            },
          }
        })
        if (!part || !changed) return false
        yield* detectTryBest(part)
        if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.blocked || ctx.shouldBreak
        }
        return true
      })

      const executeTool: Handle["executeTool"] = (tool, callID, body, options) => Effect.gen(function* () {
        if (toolsClosed || options?.signal?.aborted) return yield* Effect.fail(new Error("Tool execution is closed"))
        const execution = Effect.gen(function* () {
          yield* Deferred.await(toolReady(callID))
          return yield* toolGate.run(options?.gateTool ?? tool, callID, Effect.gen(function* () {
            const call = ctx.toolcalls[callID]
            if (!call) return yield* Effect.fail(new Error("Tool call is not registered"))
            yield* session.mutateToolPart(call, (part) => {
              if (toolsClosed || options?.signal?.aborted) throw new Error("Tool execution is closed")
              if (!part || part.tool !== tool || part.callID !== callID || part.state.status !== "running" ||
                part.execution !== "not-started" || part.metadata?.providerExecuted) {
                throw new Error("Tool execution has no trusted input boundary")
              }
              return { ...part, execution: "started" }
            })
            const settled: { callID: string; result?: Effect.Effect<unknown, unknown> } = { callID }
            return yield* Effect.uninterruptibleMask((restore) => restore(body.pipe(
              Effect.provideService(ResultRef, settled),
            )).pipe(
              Effect.tap((output) => completeToolCall(callID, output)),
              Effect.onExit((exit) => Exit.isFailure(exit) && settled.result
                ? settled.result.pipe(Effect.matchEffect({
                    onSuccess: (output) => completeToolCall(callID, output),
                    onFailure: (error) => failToolCall(callID, error).pipe(Effect.asVoid),
                  }))
                : Effect.void),
              Effect.tapError((error) => failToolCall(callID, error)),
            ))
          }), { signal: options?.signal })
        })
        const fiber = yield* execution.pipe(Effect.forkIn(toolScope))
        // Unwrap Exit after notification; join can skip concurrent scope waiters on interruption in Effect beta.48.
        const exit = yield* Fiber.await(fiber)
        return yield* exit
      })

      const checkTextNgram = (text: string) => {
        if (ctx.textNgramRepeat || !ctx.textNgramMonitor) return
        if (ctx.textNgramMonitor.append(text)) ctx.textNgramRepeat = true
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "start":
            // First provider frame of this process() marks busy. Later frames belong
            // to request-ladder retries of the same attempt and must not clobber
            // session.status{retry} (the reconnect row is the only user-visible wait).
            if (isMain && !ctx.startedBusy) {
              ctx.startedBusy = true
              yield* status.set(ctx.sessionID, { type: "busy" })
            }
            return

          case "reasoning-start":
            ctx.retrying = false
            if (isMain) yield* status.set(ctx.sessionID, { type: "busy" })
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              // Replayed candidates (max mode) carry a backdated start so the
              // displayed thinking duration reflects the real candidate latency
              // instead of the ~1ms synthetic replay. Live streams omit `time`.
              time: { start: (value as { time?: { start: number } }).time?.start ?? Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            ctx.stepPartIds.push(ctx.reasoningMap[value.id].id)
            return

          case "reasoning-delta":
            if (!ctx.firstTokenAt) ctx.firstTokenAt = Date.now()
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            checkTextNgram(value.text)
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (!(value.id in ctx.reasoningMap)) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text
            ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePart(ctx.reasoningMap[value.id])
            delete ctx.reasoningMap[value.id]
            return

          case "tool-input-start":
            ctx.retrying = false
            if (isMain) yield* status.set(ctx.sessionID, { type: "busy" })
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            if (toolsClosed) return
            const partID = ctx.toolcalls[value.id]?.partID ?? PartID.ascending()
            const part = yield* session.mutateToolPart({
              partID, messageID: ctx.assistantMessage.id, sessionID: ctx.sessionID,
            }, (current) => current ? {
              ...current,
              metadata: value.providerExecuted ? { ...current.metadata, providerExecuted: true } : current.metadata,
            } : {
              id: partID,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: value.toolName,
              callID: value.id,
              execution: !value.providerExecuted && localTools.has(value.toolName) ? "not-started" : undefined,
              state: { status: "pending", input: {}, raw: "" },
              metadata: value.providerExecuted ? { providerExecuted: true } : undefined,
            })
            if (!part) throw new Error("Tool registration was not persisted")
            ctx.stepPartIds.push(part.id)
            ctx.toolcalls[value.id] = {
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
            }
            return

          case "tool-input-delta":
            return

          case "tool-input-end":
            return

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            // A tool call may already have caused an external side effect before
            // the provider stream fails. Replaying the whole model step is unsafe.
            ctx.retrySafe = false
            yield* updateToolCall(value.toolCallId, (match) => ({
              ...match,
              tool: value.toolName,
              execution: match.execution ?? (match.state.status === "pending" && localTools.has(value.toolName) &&
                !match.metadata?.providerExecuted && !value.providerExecuted ? "not-started" : undefined),
              state: match.state.status !== "pending" ? match.state : {
                status: "running",
                input: value.input,
                time: { start: Date.now() },
              },
              metadata: match.metadata?.providerExecuted || value.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))
            yield* Deferred.succeed(toolReady(value.toolCallId), undefined)

            const parts = MessageV2.parts(ctx.assistantMessage.id)
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.toolName &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(value.input),
              )
            ) {
              return
            }

            const agent = yield* resolveStoredAgent(agents, ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.toolName],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.toolName, input: value.input },
              always: [value.toolName],
              ruleset: agent.permission,
              // System-spawned background agents have no human to answer — fail clean.
              interactive: !SYSTEM_SPAWNED_AGENT_TYPES.has(ctx.assistantMessage.agent),
            })
            return
          }

          case "tool-result": {
            if (value.providerExecuted) yield* updateToolCall(value.toolCallId, (part) => ({
              ...part, metadata: { ...part.metadata, providerExecuted: true },
            }))
            yield* completeToolCall(value.toolCallId, value.output, value.providerMetadata)
            return
          }

          case "tool-error": {
            if (value.providerExecuted) yield* updateToolCall(value.toolCallId, (part) => ({
              ...part, metadata: { ...part.metadata, providerExecuted: true },
            }))
            yield* failToolCall(value.toolCallId, value.error)
            yield* bus
              .publish(Metrics.ToolCall, {
                sessionID: ctx.sessionID,
                tool_name: metricToolName(value.toolName, value.input),
                input_bytes: Metrics.jsonByteLength(value.input),
                output_bytes: 0,
                tool_call_id: value.toolCallId,
                tool_call_status: "error",
              })
              .pipe(Effect.ignore)
            return
          }

          case "error":
            throw value.error

          case "start-step":
            ctx.stepStartedAt = Date.now()
            ctx.firstTokenAt = undefined
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            const stepStartPartId = PartID.ascending()
            yield* session.updatePart({
              id: stepStartPartId,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            ctx.stepPartIds.push(stepStartPartId)
            return

          case "finish-step": {
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage,
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.finishReason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.finishReason,
              snapshot: yield* snapshot.track(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            let stepFilesChanged = 0
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              stepFilesChanged = patch.files.length
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            const stepTokensIn = usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write
            const stepTokensOut = usage.tokens.output + usage.tokens.reasoning
            if (ctx.agentMetrics) {
              ctx.agentMetrics.tokens_in += stepTokensIn
              ctx.agentMetrics.tokens_out += stepTokensOut
              ctx.agentMetrics.files_changed += stepFilesChanged
            }
            yield* bus
              .publish(Metrics.ModelCall, {
                sessionID: ctx.sessionID,
                finish_reason: value.finishReason,
                ttft_ms: ctx.firstTokenAt && ctx.stepStartedAt ? ctx.firstTokenAt - ctx.stepStartedAt : undefined,
                latency_ms: ctx.stepStartedAt ? Date.now() - ctx.stepStartedAt : 0,
                cached_read_tokens: usage.tokens.cache.read,
                model_id: ctx.model.id,
                provider: ctx.model.providerID,
                total_tokens_in: stepTokensIn,
                total_tokens_out: stepTokensOut,
              })
              .pipe(Effect.ignore)
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsOverflowHandling = true
            }
            return
          }

          case "text-start":
            ctx.retrying = false
            if (isMain) yield* status.set(ctx.sessionID, { type: "busy" })
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            ctx.textPartPersisted = false
            return

          case "text-delta":
            if (!ctx.firstTokenAt) ctx.firstTokenAt = Date.now()
            if (!ctx.currentText) return
            if (!value.text) return
            if (!ctx.textPartPersisted) {
              ctx.textPartPersisted = true
              yield* session.updatePart(ctx.currentText)
              ctx.stepPartIds.push(ctx.currentText.id)
            }
            ctx.currentText.text += value.text
            checkTextNgram(value.text)
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            if (ctx.currentText.text) {
              yield* session.updatePart(ctx.currentText)
            }
            ctx.currentText = undefined
            return

          case "finish":
            return

          default:
            slog.info("unhandled", { event: value.type, value })
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        yield* closeTools()
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          if (ctx.currentText.text) {
            const end = Date.now()
            ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            yield* session.updatePart(ctx.currentText)
          }
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          yield* updateToolCall(toolCallID, (part) => {
            if (part.state.status !== "pending" && part.state.status !== "running") return part
            return { ...part, state: MessageV2.abortedToolState(
              part.state, toolGate.wasCancelled(toolCallID) ? FAIL_CASCADE_MESSAGE : undefined,
            ) }
          })
        }
        ctx.toolcalls = {}
        // Second pass, DB-driven. The loop above can only see calls this process
        // still holds in `ctx.toolcalls`, so a call whose registration lost the race
        // with teardown, or that arrived after the map was cleared, or whose
        // `readToolCall` lookup missed, keeps its persisted `running` status forever
        // — the transcript then shows a tool call that will never finish. Every tool
        // part of THIS assistant message belongs to the turn being torn down here,
        // so any part still `pending`/`running` is unfinalized by definition.
        // Idempotent: the pass above already rewrote the tracked ones.
        for (const part of yield* Effect.sync(() => MessageV2.parts(ctx.assistantMessage.id))) {
          if (part.type !== "tool") continue
          if (part.state.status !== "pending" && part.state.status !== "running") continue
          yield* session.mutateToolPart({ sessionID: part.sessionID, messageID: part.messageID, partID: part.id }, (current) => {
            if (!current || (current.state.status !== "pending" && current.state.status !== "running")) return current
            return { ...current, state: MessageV2.abortedToolState(
              current.state, toolGate.wasCancelled(current.callID) ? FAIL_CASCADE_MESSAGE : undefined,
            ) }
          })
        }
        // 有 error = 没完成 = 留在 /recovery 候选集里。不管错误类型(瞬态/终态/用户中止),
        // 只要消息带 error,就不写 completed,让 resume 端点能找到它。
        // 正常完成(无 error)才标记 completed。
        if (!ctx.assistantMessage.error) {
          ctx.assistantMessage.time.completed = Date.now()
        }
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        const error = parse(e)
        if (MessageV2.ContextOverflowError.isInstance(error)) {
          ctx.needsOverflowHandling = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        // Do NOT status.set(idle) here. halt runs before cleanup and the outer
        // work ensuring (orphan sweep). Publishing idle first lets the client
        // finish/unsubscribe, then the sweep's part.updated lands on the NEXT
        // turn's subscription (RL-ORPHAN-D01). Idle is published by
        // SessionRunState onIdle after the work Effect (including ensuring)
        // exits.
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        slog.info("process")
        ctx.needsOverflowHandling = false
        const cfg = yield* config.get()
        ctx.shouldBreak = cfg.experimental?.continue_loop_on_deny !== true
        const retryConfig = SessionRetry.resolve(cfg, streamInput.model.providerID)
        ctx.retrying = false
        ctx.retryWaiter = undefined
        ctx.superseded = false
        // A newer input supersedes the step only while it is failing: once the input
        // waits, the step gives way at its current retry or at the next one.
        const supersede = (awaitNewInput: Effect.Effect<void>) =>
          Effect.gen(function* () {
            yield* awaitNewInput
            if (!ctx.retrying) {
              const waiter = yield* Deferred.make<void>()
              ctx.retryWaiter = waiter
              yield* Deferred.await(waiter)
            }
            ctx.superseded = true
          })

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            ctx.stepPartIds = []
            ctx.toolcalls = {}
            if (toolsClosed) {
              toolScope = yield* Scope.make()
              toolsClosed = false
              ready.clear()
            }
            ctx.retrySafe = true
            ctx.startedBusy = false
            ctx.textNgramRepeat = false
            ctx.textNgramMonitor = createTextNgramMonitor()
            const stream = llm.stream({
              ...streamInput,
              assistantMessageID: ctx.assistantMessage.id,
              // Request-ladder retries must write SessionStatus (not just bus events):
              // GET /session/status serves the same map after renderer reload.
              onRetryStatus: (info) =>
                Effect.gen(function* () {
                  yield* recordRetry({
                    phase: info.phase ?? "request",
                    scope: info.scope ?? "request",
                    kind: info.kind,
                    message: info.message,
                    hostCode: info.hostCode,
                    next: info.next,
                  })
                  if (!isMain) return
                  yield* status.setRetry(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    phaseAttempt: info.attempt,
                    message: info.message,
                    next: info.next,
                    phase: info.phase,
                    scope: info.scope,
                    hostCode: info.hostCode,
                  })
                }),
            })

            yield* stream.pipe(
              Stream.tap(handleEvent),
              Stream.takeUntil(() => ctx.needsOverflowHandling || ctx.textNgramRepeat || ctx.blocked),
              Stream.runDrain,
              Effect.ensuring(closeTools()),
            )

            // Empty / think-only output is a failed step. Raise InvalidOutputError
            // so SessionRetry.policy (decide → persistent server budget) owns the
            // retry instead of a parallel counter. Clear the empty turn's parts so
            // it never sits in session history, keeping the assistant identity the
            // retry writes into.
            // Length finish is owned by autoContinueOutputLength; json_schema
            // empty output is owned by structured-output retry.
            // Only replay when the stream is retrySafe (no tool side effects) and
            // the turn has no tool residue — otherwise the runLoop's
            // dropEmptyAssistant starts a fresh step instead of replaying.
            if (!ctx.needsOverflowHandling && !ctx.textNgramRepeat && !ctx.blocked && !ctx.assistantMessage.error) {
              const parts = MessageV2.parts(ctx.assistantMessage.id)
              const classification = classifyAssistantStep({
                phase: "after-process",
                lastUser: streamInput.user,
                assistant: ctx.assistantMessage,
                parts,
                processResult: "stop",
              })
              const hasToolParts = parts.some((part) => part.type === "tool")
              if (
                (classification.type === "think-only" || classification.type === "invalid") &&
                ctx.assistantMessage.finish !== "length" &&
                streamInput.user.format?.type !== "json_schema" &&
                ctx.retrySafe &&
                !hasToolParts
              ) {
                const reason = classification.type === "invalid" ? classification.reason : "think-only"
                slog.info("invalid output, dropping empty turn", { reason, finish: ctx.assistantMessage.finish })
                // Reset the content but keep the message identity: removing the message and
                // rebuilding it under the same ID is indistinguishable, on the wire, from a
                // late frame of an already-deleted entity, so consumers that order by events
                // discard the retried content for good.
                for (const part of parts) {
                  if (part.type === "retry") continue
                  yield* session.removePart({
                    sessionID: ctx.sessionID,
                    messageID: ctx.assistantMessage.id,
                    partID: part.id,
                  })
                }
                ctx.assistantMessage.finish = undefined
                ctx.assistantMessage.error = undefined
                ctx.assistantMessage.time.completed = undefined
                ctx.stepPartIds = []
                yield* session.updateMessage(ctx.assistantMessage)
                return yield* Effect.fail(new MessageV2.InvalidOutputError({ message: reason }))
              }
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                if (ctx.superseded) return
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.tapError(() =>
              Effect.gen(function* () {
                if (!ctx.retrySafe) return
                for (const partId of ctx.stepPartIds) {
                  yield* session.removePart({
                    sessionID: ctx.sessionID,
                    messageID: ctx.assistantMessage.id,
                    partID: partId,
                  })
                }
                ctx.stepPartIds = []
              }),
            ),
            Effect.retry(
              SessionRetry.policy({
                parse,
                phase: "stream",
                budget: (decision) => SessionRetry.budgetFor(retryConfig, decision),
                jitterRatio: retryConfig.jitterRatio,
                replaySafe: () => ctx.retrySafe,
                silentRetry: (error) => isMain && SessionRetry.isGptServerOverloadedError(error),
                onTerminal: (decision) =>
                  isMain && decision.uiMessage
                    ? status.set(ctx.sessionID, { type: "notice", message: decision.uiMessage })
                    : Effect.void,
                set: (info) =>
                  Effect.gen(function* () {
                    yield* recordRetry({
                      phase: info.phase,
                      scope: info.scope,
                      kind: info.kind,
                      message: info.message,
                      hostCode: info.hostCode,
                      next: info.next,
                    })
                    let attempt = info.attempt
                    if (isMain) {
                      attempt = yield* status.setRetry(ctx.sessionID, {
                        type: "retry",
                        attempt: info.attempt,
                        phaseAttempt: info.attempt,
                        message: info.message,
                        next: info.next,
                        phase: info.phase,
                        scope: info.scope,
                        hostCode: info.hostCode,
                      })
                    }
                    yield* bus
                      .publish(Session.Event.RetryAttempt, {
                        sessionID: ctx.sessionID,
                        messageID: ctx.assistantMessage.id,
                        attempt,
                        phaseAttempt: info.attempt,
                        maxAttempts: info.maxAttempts,
                        phase: info.phase,
                        kind: info.kind,
                        scope: info.scope,
                        reason: info.message,
                        nextDelayMs: Math.max(0, info.next - Date.now()),
                        hostCode: info.hostCode,
                      })
                      .pipe(Effect.ignore)
                  }),
              }),
            ),
            (retried) => (input.awaitNewInput ? Effect.raceFirst(retried, supersede(input.awaitNewInput)) : retried),
            Effect.catch((e) =>
              Effect.gen(function* () {
                // Codex-style auto-resume: after tools have fully completed, a
                // retryable transport failure (timeout / disconnect / 5xx) must NOT
                // stamp a terminal ErrorCard. Replaying this stream is unsafe
                // (tools already ran), but the outer runLoop can start the next
                // step from session history that already carries tool results —
                // equivalent to an automatic Resume of the next sampling call.
                // User abort (cancel / interrupt) is terminal: never auto-resume.
                if (aborted) {
                  yield* halt(e)
                  return
                }
                if (!ctx.retrySafe) {
                  const decision = SessionRetry.decide(parse(e), "stream", "live-step")
                  const parts = MessageV2.parts(ctx.assistantMessage.id)
                  const toolParts = parts.filter((p) => p.type === "tool")
                  const hasFinalText = parts.some(
                    (p) => p.type === "text" && !p.synthetic && !p.ignored && p.text.trim().length > 0,
                  )
                  if (
                    shouldAutoResumeAfterTools({
                      retrySafe: ctx.retrySafe,
                      decision,
                      toolParts,
                      aborted,
                      finish: ctx.assistantMessage.finish,
                      hasFinalText,
                    })
                  ) {
                    slog.info("auto-resume after tools", {
                      kind: decision.kind,
                      message: decision.message,
                      tools: toolParts.length,
                    })
                    yield* recordRetry({
                      phase: "stream",
                      scope: "live-step",
                      kind: decision.kind,
                      message: decision.message,
                      hostCode: decision.hostCode,
                      next: Date.now(),
                    })
                    if (isMain) {
                      yield* status
                        .setRetry(ctx.sessionID, {
                          type: "retry",
                          attempt: 1,
                          phaseAttempt: 1,
                          message: decision.message,
                          next: Date.now(),
                          phase: "stream",
                          scope: "live-step",
                          hostCode: decision.hostCode,
                        })
                        .pipe(Effect.ignore)
                    }
                    // Keep tool parts; mark the step as tool-calls so classify
                    // continues. Do NOT write assistant.error (that is terminal).
                    ctx.assistantMessage.finish = "tool-calls"
                    ctx.assistantMessage.error = undefined
                    yield* session.updateMessage(ctx.assistantMessage)
                    return
                  }
                  // Trailing transport failure after a completed answer (finish=stop/other
                  // + final text): keep the answer, do not stamp an ErrorCard, do not
                  // reopen. Fall through to a clean "stop" via the tail below.
                  if (
                    (ctx.assistantMessage.finish === "stop" || ctx.assistantMessage.finish === "other") &&
                    hasFinalText
                  ) {
                    slog.info("ignore trailing transport error after finished turn", {
                      kind: decision.kind,
                      message: decision.message,
                      finish: ctx.assistantMessage.finish,
                    })
                    ctx.assistantMessage.error = undefined
                    yield* session.updateMessage(ctx.assistantMessage)
                    return
                  }
                }
                yield* halt(e)
              }),
            ),
            Effect.ensuring(cleanup()),
          )

          if (ctx.superseded) {
            // The superseded step keeps only its retry record, which stays visible
            // until the turn succeeds; it is complete so no orphan sweep aborts it.
            for (const partId of ctx.stepPartIds) {
              yield* session.removePart({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: partId,
              })
            }
            ctx.stepPartIds = []
            ctx.assistantMessage.finish = undefined
            ctx.assistantMessage.error = undefined
            ctx.assistantMessage.time.completed = Date.now()
            yield* session.updateMessage(ctx.assistantMessage)
            if (isMain) yield* status.set(ctx.sessionID, { type: "busy" })
            slog.info("retry superseded by new input", { attempt: ctx.retryPart?.attempt })
            return "superseded"
          }
          if (ctx.needsOverflowHandling) return "overflow"
          if (ctx.textNgramRepeat) return "text-repeat"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      const replay = Effect.fn("SessionProcessor.replay")(function* (input: ReplayInput) {
        slog.info("replay", { toolCalls: input.toolCalls.length, finish: input.finishReason })
        ctx.needsOverflowHandling = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        const ctrl = new AbortController()

        const emptyUsage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        }

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}

            // Mirror a real model call: start → start-step → reasoning → text →
            // (tool-input-start → tool-call → execute → tool-result)* → finish-step
            yield* handleEvent({ type: "start" } as StreamEvent)
            yield* handleEvent({
              type: "start-step",
              request: {},
              warnings: [],
            } as unknown as StreamEvent)

            const selectionNote = input.selection
              ? `[max mode] selected candidate ${input.selection.winner + 1} of ${input.selection.total}`
              : undefined
            const reasoningText = [selectionNote, input.reasoning].filter(Boolean).join("\n\n")

            if (reasoningText) {
              const rid = "reasoning-replay"
              const backdatedStart = input.thinkingMs ? Date.now() - input.thinkingMs : undefined
              yield* handleEvent({
                type: "reasoning-start",
                id: rid,
                providerMetadata: input.reasoningMetadata,
                ...(backdatedStart ? { time: { start: backdatedStart } } : {}),
              } as unknown as StreamEvent)
              yield* handleEvent({
                type: "reasoning-delta",
                id: rid,
                text: reasoningText,
                providerMetadata: input.reasoningMetadata,
              } as unknown as StreamEvent)
              yield* handleEvent({
                type: "reasoning-end",
                id: rid,
                providerMetadata: input.reasoningMetadata,
              } as unknown as StreamEvent)
            }

            if (input.text) {
              const tid = "text-replay"
              yield* handleEvent({
                type: "text-start",
                id: tid,
                providerMetadata: input.textMetadata,
              } as unknown as StreamEvent)
              yield* handleEvent({
                type: "text-delta",
                id: tid,
                text: input.text,
                providerMetadata: input.textMetadata,
              } as unknown as StreamEvent)
              yield* handleEvent({
                type: "text-end",
                id: tid,
                providerMetadata: input.textMetadata,
              } as unknown as StreamEvent)
            }

            for (const call of input.toolCalls) {
              if (ctx.needsOverflowHandling || ctx.blocked) break
              yield* handleEvent({
                type: "tool-input-start",
                id: call.toolCallId,
                toolName: call.toolName,
                providerMetadata: call.providerMetadata,
              } as unknown as StreamEvent)
              yield* handleEvent({
                type: "tool-call",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
                providerMetadata: call.providerMetadata,
              } as unknown as StreamEvent)

              const t = input.tools[call.toolName]
              if (!t || !t.execute) {
                yield* handleEvent({
                  type: "tool-error",
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  input: call.input,
                  error: new Error(`Tool "${call.toolName}" has no executor`),
                } as unknown as StreamEvent)
                continue
              }

              const outcome = yield* Effect.tryPromise({
                try: () =>
                  t.execute!(call.input, {
                    toolCallId: call.toolCallId,
                    messages: input.messages,
                    abortSignal: ctrl.signal,
                  }),
                catch: (e) => e,
              }).pipe(
                Effect.map((output) => ({ ok: true as const, output })),
                Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
              )

              if (!outcome.ok) {
                yield* handleEvent({
                  type: "tool-error",
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  input: call.input,
                  error: outcome.error,
                } as unknown as StreamEvent)
              } else {
                // The execute closure resolves with { title, metadata, output, attachments }.
                // Feeding it through the tool-result handler completes the part
                // (unless execute already completed it on abort — completeToolCall
                // is a no-op once the part is no longer "running").
                yield* handleEvent({
                  type: "tool-result",
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  input: call.input,
                  output: outcome.output,
                } as unknown as StreamEvent)
              }
            }

            yield* handleEvent({
              type: "finish-step",
              usage: input.usage ?? emptyUsage,
              finishReason: input.finishReason,
              providerMetadata: input.providerMetadata,
            } as unknown as StreamEvent)

            // Account for ensemble overhead (losing candidates + judge): real
            // spend that consumed no context. Add it to cost + agent metrics +
            // a supplementary ModelCall metric, but NOT to message.tokens (set
            // by the finish-step above from the winner only) so context
            // estimators stay honest.
            if (
              input.overhead &&
              (input.overhead.cost > 0 || input.overhead.tokensIn > 0 || input.overhead.tokensOut > 0)
            ) {
              ctx.assistantMessage.cost += input.overhead.cost
              yield* session.updateMessage(ctx.assistantMessage)
              if (ctx.agentMetrics) {
                ctx.agentMetrics.tokens_in += input.overhead.tokensIn
                ctx.agentMetrics.tokens_out += input.overhead.tokensOut
              }
              yield* bus
                .publish(Metrics.ModelCall, {
                  sessionID: ctx.sessionID,
                  finish_reason: "max-mode-overhead",
                  latency_ms: 0,
                  cached_read_tokens: 0,
                  model_id: ctx.model.id,
                  provider: ctx.model.providerID,
                  total_tokens_in: input.overhead.tokensIn,
                  total_tokens_out: input.overhead.tokensOut,
                })
                .pipe(Effect.ignore)
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                // Propagate cancellation into the currently-executing tool so a
                // long-running winner tool call is actually interrupted.
                ctrl.abort()
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsOverflowHandling) return "overflow"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        toolGate,
        registerTool: (name) => { localTools.add(name) },
        executeTool,
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
        replay,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
