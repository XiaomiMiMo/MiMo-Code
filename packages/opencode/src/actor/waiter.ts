import { Context, Deferred, Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { ActorRegistry } from "@/actor/registry"
import type { Actor } from "@/actor/schema"
import { Session } from "@/session"
import type { SessionID } from "@/session/schema"
import { ActorStatusChanged } from "@/actor/events"
import { parseReturnHeader, type ReturnStatus } from "@/actor/return-header"

export interface WaitResult {
  status: Actor["status"] | "timeout" | "unknown"
  actor_id: string
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
  // reconciled status from the spawn outcome Deferred instead.
  reportedStatus?: ReturnStatus
  reportedSummary?: string
  time?: { created: number; updated: number; completed?: number }
}

const DEFAULT_TIMEOUT_MS = 600_000

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
  readonly wait: (input: {
    sessionID: SessionID
    actor_id: string
    timeout_ms?: number
  }) => Effect.Effect<WaitResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ActorWaiter") {}

export const layer: Layer.Layer<Service, never, Bus.Service | ActorRegistry.Service | Session.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const reg = yield* ActorRegistry.Service
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service

    // Pull the most recent assistant text + structured object from the actor's
    // slice. Used as result body when the actor reaches idle/success on
    // ephemeral actors. structured (json_schema) takes precedence over text:
    // when present, the text part (often a pre-tool-call preamble) is dropped to
    // avoid duplicating the result downstream (spec §5.2).
    const lastAssistantResult = (sessionID: SessionID, actorID: string) =>
      Effect.gen(function* () {
        const msgs = yield* sessions.messages({ sessionID, agentID: actorID })
        const last = msgs.findLast((m) => m.info.role === "assistant")
        if (!last) return { result: undefined as string | undefined, structured: undefined as unknown }
        const structured = last.info.role === "assistant" ? last.info.structured : undefined
        if (structured !== undefined) return { result: undefined as string | undefined, structured }
        const textPart = last.parts.findLast(
          (p): p is Extract<(typeof last.parts)[number], { type: "text" }> => p.type === "text",
        )
        return { result: textPart?.text, structured: undefined as unknown }
      })

    const snapshot = (sessionID: SessionID, actorID: string, entry: Actor): Effect.Effect<WaitResult> =>
      Effect.gen(function* () {
        const extracted =
          entry.status === "idle" && entry.lastOutcome === "success"
            ? yield* lastAssistantResult(sessionID, actorID)
            : { result: undefined as string | undefined, structured: undefined as unknown }
        const reported = parseReturnHeader(extracted.result)
        return {
          status: entry.status,
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
          time: entry.time,
        }
      })

    const wait = Effect.fn("ActorWaiter.wait")(function* (input: {
      sessionID: SessionID
      actor_id: string
      timeout_ms?: number
    }) {
      // Fast path: registry already in a wait-resolving state.
      const entry = yield* reg.get(input.sessionID, input.actor_id)
      if (!entry) return { status: "unknown" as const, actor_id: input.actor_id }
      if (isWaitResolving(entry)) return yield* snapshot(input.sessionID, input.actor_id, entry)

      const resolved = yield* Deferred.make<WaitResult>()
      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS

      return yield* Effect.acquireUseRelease(
        bus.subscribeCallback(ActorStatusChanged, (evt) => {
          if (evt.properties.actorID !== input.actor_id) return
          if (evt.properties.sessionID !== input.sessionID) return
          // ActorStatusChanged carries status + lastOutcome but not lifecycle.
          // Re-read the row to get lifecycle (the missing predicate input).
          Effect.runFork(
            Effect.gen(function* () {
              const fresh = yield* reg.get(input.sessionID, input.actor_id)
              if (!fresh) return
              if (!isWaitResolving(fresh)) return
              const snap = yield* snapshot(input.sessionID, input.actor_id, fresh)
              Deferred.doneUnsafe(resolved, Effect.succeed(snap))
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`waiter rehydrate failed: ${cause}`),
              ),
            ),
          )
        }),
        () =>
          Effect.gen(function* () {
            // Re-check after subscribing — the row could have flipped between
            // the initial get() above and the bus.subscribeCallback bind.
            const recheck = yield* reg.get(input.sessionID, input.actor_id)
            if (recheck && isWaitResolving(recheck)) {
              return yield* snapshot(input.sessionID, input.actor_id, recheck)
            }
            const raced = yield* Deferred.await(resolved).pipe(
              Effect.timeout(timeoutMs),
              Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
            )
            if (raced === null) {
              return { status: "timeout" as const, actor_id: input.actor_id }
            }
            return raced
          }),
        (unsub) => Effect.sync(() => unsub()),
      )
    })

    return Service.of({ wait })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(ActorRegistry.defaultLayer),
  Layer.provide(Session.defaultLayer),
)

export * as ActorWaiter from "./waiter"
