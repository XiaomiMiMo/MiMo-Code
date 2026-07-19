import { Deferred, Effect } from "effect"
import type { Bus } from "@/bus"
import type { ActorRegistry } from "@/actor/registry"
import type { Actor } from "@/actor/schema"
import type { Session } from "@/session"
import type { SessionID } from "@/session/schema"
import { ActorStatusChanged } from "@/actor/events"
import { parseReturnHeader } from "@/actor/return-header"

// One member's terminal outcome within a joined dispatch group.
export interface GroupMemberResult {
  sessionID: SessionID
  actorID: string
  description?: string
  agent?: string
  // The aggregation bucket. "unknown" = the member was never a registered actor
  // (bad id); it can never become terminal, so it does NOT block the barrier.
  outcome: "success" | "failure" | "cancelled" | "unknown"
  result?: string
  error?: string
  reportedStatus?: string
  reportedSummary?: string
}

export interface JoinResult {
  status: "complete" | "timeout"
  total: number
  counts: { success: number; failure: number; cancelled: number; unknown: number }
  members: GroupMemberResult[]
}

export interface JoinDeps {
  reg: ActorRegistry.Interface
  sessions: Session.Interface
  bus: Bus.Interface
}

const DEFAULT_TIMEOUT_MS = 600_000

// A group member is terminal once its actor row is idle WITH an outcome. Unlike
// the single-actor waiter (which ignores a persistent peer's idle/success so it
// can keep relaying), fan-in counts EVERY terminal outcome — success, failure,
// AND cancel (all three now flow through ActorTurn.runTurn / Actor.cancel and
// publish ActorStatusChanged, per T41).
function terminalOutcome(entry: Actor | undefined): "success" | "failure" | "cancelled" | undefined {
  if (!entry) return undefined
  if (entry.status !== "idle") return undefined
  return entry.lastOutcome
}

type Member = { sessionID: SessionID; actorID: string }
type Resolved = "success" | "failure" | "cancelled" | "unknown"

// Fan-in barrier: register interest in a GROUP of child actors (each keyed by
// its session id + actor id — for a peer both equal the child session id) and
// resolve ONCE when EVERY member has reached a terminal state, returning an
// aggregated per-member summary. Does NOT busy-wait: it subscribes to
// ActorStatusChanged (the same notification path T41 drives) and re-snapshots
// the group on each touching event. A member that is already terminal (or
// unknown — a bad id that has no row and can never settle) at call time is
// counted immediately; the barrier resolves synchronously if all are settled.
//
// Standalone Effect (mirrors forkQuery in tool/session.ts) rather than a Layer
// service: it needs only the registry + session + bus interfaces the caller
// already holds — so it adds no new layer dependency and no cycle. It takes the
// INJECTED Bus.Interface (not the static Bus.subscribe) so it subscribes to the
// exact same PubSub instance the ActorRegistry layer publishes ActorStatusChanged
// on — the static builds its own runtime and would miss layer-emitted events.
export function joinGroup(
  deps: JoinDeps,
  input: { members: Member[]; timeout_ms?: number },
): Effect.Effect<JoinResult> {
  return Effect.gen(function* () {
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS

    // Dedup members by sessionID:actorID — a caller may list the same child
    // twice; the barrier must count it once.
    const seen = new Set<string>()
    const members = input.members.filter((m) => {
      const key = `${m.sessionID}:${m.actorID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    if (members.length === 0)
      return {
        status: "complete" as const,
        total: 0,
        counts: { success: 0, failure: 0, cancelled: 0, unknown: 0 },
        members: [],
      }

    const lastAssistantText = (sessionID: SessionID, actorID: string) =>
      Effect.gen(function* () {
        const msgs = yield* deps.sessions
          .messages({ sessionID, agentID: actorID })
          .pipe(Effect.orElseSucceed(() => []))
        const last = msgs.findLast((m) => m.info.role === "assistant")
        if (!last) return undefined
        const textPart = last.parts.findLast(
          (p): p is Extract<(typeof last.parts)[number], { type: "text" }> => p.type === "text",
        )
        return textPart?.text
      })

    const memberResult = (m: Member, entry: Actor | undefined, outcome: Resolved) =>
      Effect.gen(function* () {
        const result = outcome === "success" ? yield* lastAssistantText(m.sessionID, m.actorID) : undefined
        const reported = parseReturnHeader(result)
        return {
          sessionID: m.sessionID,
          actorID: m.actorID,
          ...(entry?.description !== undefined ? { description: entry.description } : {}),
          ...(entry?.agent !== undefined ? { agent: entry.agent } : {}),
          outcome,
          ...(result !== undefined ? { result } : {}),
          ...(outcome === "failure" && entry?.lastError !== undefined ? { error: entry.lastError } : {}),
          ...(reported.status ? { reportedStatus: reported.status } : {}),
          ...(reported.summary ? { reportedSummary: reported.summary } : {}),
        } satisfies GroupMemberResult
      })

    // Snapshot every member's current terminal state. `settled` = terminal or
    // unknown (a member that can never become terminal must not block).
    const snapshotAll = () =>
      Effect.forEach(members, (m) =>
        Effect.gen(function* () {
          const entry = yield* deps.reg.get(m.sessionID, m.actorID)
          const term = terminalOutcome(entry)
          const outcome: Resolved | undefined = term ?? (entry ? undefined : "unknown")
          return { m, entry, settled: outcome !== undefined, outcome }
        }),
      )

    const aggregate = (
      resolved: { m: Member; entry: Actor | undefined; outcome: Resolved }[],
      status: "complete" | "timeout",
    ) =>
      Effect.gen(function* () {
        const out = yield* Effect.forEach(resolved, (r) => memberResult(r.m, r.entry, r.outcome))
        const counts = {
          success: out.filter((x) => x.outcome === "success").length,
          failure: out.filter((x) => x.outcome === "failure").length,
          cancelled: out.filter((x) => x.outcome === "cancelled").length,
          unknown: out.filter((x) => x.outcome === "unknown").length,
        }
        return { status, total: out.length, counts, members: out } satisfies JoinResult
      })

    // Fast path: everyone already settled.
    const initial = yield* snapshotAll()
    if (initial.every((r) => r.settled))
      return yield* aggregate(
        initial.map((r) => ({ m: r.m, entry: r.entry, outcome: r.outcome! })),
        "complete",
      )

    const resolved = yield* Deferred.make<JoinResult>()

    return yield* Effect.acquireUseRelease(
      // On each status change touching a member, re-snapshot the whole group and
      // resolve only when ALL are settled. Re-snapshotting (vs a per-member
      // latch) keeps state authoritative against the DB and idempotent under
      // duplicate/out-of-order events.
      deps.bus.subscribeCallback(ActorStatusChanged, (evt) => {
          const touched = members.some(
            (m) => m.actorID === evt.properties.actorID && m.sessionID === evt.properties.sessionID,
          )
          if (!touched) return
          Effect.runFork(
            Effect.gen(function* () {
              const snap = yield* snapshotAll()
              if (!snap.every((r) => r.settled)) return
              const agg = yield* aggregate(
                snap.map((r) => ({ m: r.m, entry: r.entry, outcome: r.outcome! })),
                "complete",
              )
              Deferred.doneUnsafe(resolved, Effect.succeed(agg))
            }).pipe(Effect.catchCause((cause) => Effect.logError(`group join snapshot failed: ${cause}`))),
          )
        }),
      () =>
        Effect.gen(function* () {
          // Re-check after subscribing — a member could have flipped terminal
          // between the initial snapshot and the bus bind (lost-wakeup guard).
          const recheck = yield* snapshotAll()
          if (recheck.every((r) => r.settled))
            return yield* aggregate(
              recheck.map((r) => ({ m: r.m, entry: r.entry, outcome: r.outcome! })),
              "complete",
            )
          const raced = yield* Deferred.await(resolved).pipe(
            Effect.timeout(timeoutMs),
            Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
          )
          if (raced === null) {
            // Timed out — return the partial snapshot so the caller still sees
            // which members settled. status: "timeout" signals not-all-done.
            const partial = yield* snapshotAll()
            return yield* aggregate(
              partial.map((r) => ({ m: r.m, entry: r.entry, outcome: (r.outcome ?? "unknown") as Resolved })),
              "timeout",
            )
          }
          return raced
        }),
      (unsub) => Effect.sync(() => unsub()),
    )
  })
}
