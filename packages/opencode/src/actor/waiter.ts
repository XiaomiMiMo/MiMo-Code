import { Context, Deferred, Effect, Fiber, Layer, Scheduler } from "effect"
import { Bus } from "@/bus"
import { ActorExecution } from "@/actor/execution"
import { SessionRunState } from "@/session/run-state"
import { ActorRegistry } from "@/actor/registry"
import type { Actor } from "@/actor/schema"
import { Session } from "@/session"
import type { SessionID, MessageID } from "@/session/schema"
import { ActorStatusChanged } from "@/actor/events"
import { parseReturnHeader, type ReturnStatus } from "@/actor/return-header"
import { turnQueueRef } from "@/turn-queue"

export type ExecutionState = "running" | "completed" | "failed" | "cancelled" | "stopped"

// A read-only projection, not another persisted lifecycle. Idle only describes
// scheduling; successful completion must have a recorded outcome.
function executionState(entry: Actor, active: boolean): ExecutionState {
  if (active) return "running"
  if (entry.lastOutcome === "success") return "completed"
  if (entry.lastOutcome === "failure") return "failed"
  if (entry.lastOutcome === "cancelled") return "cancelled"
  return "stopped"
}

export interface WaitResult {
  status: Actor["status"] | "timeout" | "unknown" | "interrupted"
  actor_id: string
  executionActive?: boolean
  executionState?: ExecutionState
  description?: string
  agent?: string
  background?: boolean
  turnCount?: number
  lastTurnTime?: number
  result?: string
  structured?: unknown
  error?: string
  lastOutcome?: Actor["lastOutcome"]
  // Best-effort parse of the subagent's **Status**/**Summary** header. Used by
  // the `wait` polling path; the blocking `run` path reads the authoritative
  // status from the spawn outcome Deferred instead.
  reportedStatus?: ReturnStatus
  reportedSummary?: string
  warnings?: string[]
  time?: { created: number; updated: number; completed?: number }
}

export const DEFAULT_TIMEOUT_MS = 600_000
export const WAIT_INTERRUPTED_HINT =
  "A user message arrived while you were waiting. Stop calling tools and address the user. The subagent keeps running and will notify when done — do not wait again immediately."
export const WAIT_TIMEOUT_HINT =
  "This wait timed out; this does not mean the actor stopped. Do not blindly repeat waits. Use actor status to check executionState, turnCount, and lastTurnTime, but activity alone is not proof of progress. Inspect available tool results and concrete outputs; if evidence is insufficient, use actor send to request concrete progress, partial results, and a focused wrap-up. If necessary, use actor cancel, then actor status to confirm execution has exited. Do not infer failure from elapsed time alone."

// Persistent actors stay idle without a lastOutcome before their first turn
// runs. We only resolve wait once they've completed at least one turn AND
// that turn's outcome is not "success" — i.e. the actor needs attention.
function isWaitResolving(entry: Pick<Actor, "status" | "lastOutcome" | "lifecycle">): boolean {
  return (
    entry.status === "idle" &&
    (entry.lifecycle === "ephemeral" || (entry.lastOutcome !== undefined && entry.lastOutcome !== "success"))
  )
}

export interface Interface {
  readonly status: (entry: Actor) => Effect.Effect<Actor & { executionActive: boolean; executionState: ExecutionState }>
  readonly wait: (input: {
    sessionID: SessionID
    actor_id: string
    timeout_ms?: number
    afterRevision?: number
  }) => Effect.Effect<WaitResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ActorWaiter") {}

export const layer: Layer.Layer<
  Service | ActorExecution.Service,
  never,
  Bus.Service | ActorRegistry.Service | Session.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const executions = yield* ActorExecution.Service
    const runs = yield* SessionRunState.Service
    const reg = yield* ActorRegistry.Service
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service

    const inspect = Effect.fn("ActorWaiter.inspect")(function* (entry: Actor) {
      for (;;) {
        const runner = yield* runs.executionSnapshot(entry.sessionID, entry.actorID)
        const fresh = (yield* reg.get(entry.sessionID, entry.actorID)) ?? entry
        if (!runner.isCurrent()) continue
        const execution = executions.currentUnsafe(entry.sessionID, entry.actorID)
        const waits: Effect.Effect<unknown>[] = []
        if (execution && (!execution.fiber || execution.fiber.pollUnsafe() === undefined))
          waits.push(execution.fiber ? Fiber.await(execution.fiber) : Deferred.await(execution.done))
        if (runner.fiber && runner.fiber.pollUnsafe() === undefined) waits.push(Fiber.await(runner.fiber))
        const executionActive = waits.length > 0
        // A running row can retain an older outcome across a crash or a new reservation.
        const terminal = !executionActive && fresh.status === "idle"
        const actor = {
          ...fresh,
          status: executionActive ? ("running" as const) : ("idle" as const),
          lastOutcome: terminal ? fresh.lastOutcome : undefined,
          lastError: terminal ? fresh.lastError : undefined,
          resultMessageID: terminal ? fresh.resultMessageID : undefined,
          time: { ...fresh.time, completed: terminal ? fresh.time.completed : undefined },
          executionActive,
          executionState: executionActive
            ? ("running" as const)
            : terminal
              ? executionState(fresh, false)
              : ("stopped" as const),
        }
        return { actor, waits, settled: !executionActive && (fresh.status !== "idle" || isWaitResolving(fresh)) }
      }
    }, Effect.provideService(Scheduler.PreventSchedulerYield, true))

    const status = Effect.fn("ActorWaiter.status")(function* (entry: Actor) {
      return (yield* inspect(entry)).actor
    })

    // Pull the most recent assistant text + structured object from the actor's
    // slice. Used as result body when the actor reaches idle/success on
    // ephemeral actors. structured (json_schema) takes precedence over text:
    // when present, the text part (often a pre-tool-call preamble) is dropped to
    // avoid duplicating the result downstream (spec §5.2).
    const lastAssistantResult = (sessionID: SessionID, actorID: string, messageID?: MessageID) =>
      Effect.gen(function* () {
        const msgs = yield* sessions.messages({ sessionID, agentID: actorID })
        const last = messageID
          ? msgs.find((message) => message.info.id === messageID && message.info.role === "assistant")
          : msgs.findLast((m) => m.info.role === "assistant" && (!m.info.error || m.info.actorResult))
        if (!last) return { result: undefined as string | undefined, structured: undefined as unknown }
        if (last.info.role === "assistant" && last.info.actorResult) {
          const delivery = last.info.actorResult
          return { result: delivery.finalText, structured: delivery.structured, delivery }
        }
        if (messageID) return { result: undefined as string | undefined, structured: undefined as unknown }
        const structured = last.info.role === "assistant" ? last.info.structured : undefined
        if (structured !== undefined) return { result: undefined as string | undefined, structured }
        const textPart = last.parts.findLast(
          (p): p is Extract<(typeof last.parts)[number], { type: "text" }> => p.type === "text",
        )
        return { result: textPart?.text, structured: undefined as unknown }
      })

    const snapshot = (
      sessionID: SessionID,
      actorID: string,
      entry: Actor & { executionActive: boolean; executionState: ExecutionState },
    ): Effect.Effect<WaitResult> =>
      Effect.gen(function* () {
        const extracted =
          entry.status === "idle" &&
          (entry.lastOutcome === "success" || (entry.lastOutcome === "failure" && entry.resultMessageID))
            ? yield* lastAssistantResult(sessionID, actorID, entry.resultMessageID)
            : { result: undefined as string | undefined, structured: undefined as unknown }
        const delivery = "delivery" in extracted ? extracted.delivery : undefined
        const reported = delivery
          ? { status: delivery.reportedStatus, summary: delivery.reportedSummary }
          : parseReturnHeader(extracted.result)
        return {
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
          ...(extracted.result !== undefined ? { result: extracted.result } : {}),
          ...(extracted.structured !== undefined ? { structured: extracted.structured } : {}),
          ...(reported.status ? { reportedStatus: reported.status } : {}),
          ...(reported.summary ? { reportedSummary: reported.summary } : {}),
          ...(delivery?.warnings?.length ? { warnings: delivery.warnings } : {}),
          time: entry.time,
        }
      })

    const wait = Effect.fn("ActorWaiter.wait")(function* (input: {
      sessionID: SessionID
      actor_id: string
      timeout_ms?: number
      afterRevision?: number
    }) {
      const entry = yield* reg.get(input.sessionID, input.actor_id)
      if (!entry) return { status: "unknown" as const, actor_id: input.actor_id }
      const deadline = Date.now() + (input.timeout_ms ?? DEFAULT_TIMEOUT_MS)
      const tq = turnQueueRef.current
      const lane = { sessionID: input.sessionID, agentID: "main" as const }
      const afterRev = input.afterRevision ?? (tq ? yield* tq.observeInput(lane, -1) : 0)
      const interrupted = yield* Deferred.make<void>()
      if (tq) {
        yield* tq.observeInput(lane, afterRev).pipe(
          Effect.flatMap(() => Deferred.succeed(interrupted, undefined)),
          Effect.forkScoped,
        )
      }
      let changed = yield* Deferred.make<void>()
      yield* Effect.acquireRelease(
        bus.subscribeCallback(ActorStatusChanged, (evt) => {
          if (evt.properties.actorID !== input.actor_id || evt.properties.sessionID !== input.sessionID) return
          Deferred.doneUnsafe(changed, Effect.void)
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
      for (;;) {
        // Subscribe before reading; reset before each snapshot so completion cannot fall in a gap.
        changed = yield* Deferred.make<void>()
        const fresh = yield* reg.get(input.sessionID, input.actor_id)
        if (!fresh) return { status: "unknown" as const, actor_id: input.actor_id }
        const { actor, waits, settled } = yield* inspect(fresh)
        if (settled) return yield* snapshot(input.sessionID, input.actor_id, actor)
        if (yield* Deferred.isDone(interrupted))
          return { ...(yield* snapshot(input.sessionID, input.actor_id, actor)), status: "interrupted" as const }
        const remaining = deadline - Date.now()
        if (remaining <= 0)
          return { ...(yield* snapshot(input.sessionID, input.actor_id, actor)), status: "timeout" as const }
        // Awaiting an execution observes its exit; interrupting this wait never interrupts the actor.
        yield* Effect.raceAllFirst([
          ...waits,
          Deferred.await(changed),
          Deferred.await(interrupted),
          Effect.sleep(remaining),
        ])
      }
    }, Effect.scoped)

    return Service.of({ wait, status })
  }),
).pipe(Layer.provideMerge(ActorExecution.layer), Layer.provide(SessionRunState.defaultLayer))

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(ActorRegistry.defaultLayer),
  Layer.provide(Session.defaultLayer),
)

export * as ActorWaiter from "./waiter"
