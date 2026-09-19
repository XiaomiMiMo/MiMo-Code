import { Effect, Layer, Context, Schedule } from "effect"
import { Database, inArray, eq, and, lte, sql } from "@/storage"
import { Bus } from "@/bus"
import type { SessionID, MessageID } from "@/session/schema"
import { ActorRegistryTable } from "./actor.sql"
import { PartTable, SessionTable } from "@/session/session.sql"
import type {
  Actor,
  ActorStatus,
  ActorOutcome,
  ContextMode,
  Lifecycle,
  SpawnMode,
  ToolWhitelist,
  Liveness,
} from "./schema"
import { deriveLiveness, DEFAULT_LIVENESS_ABANDON_MS } from "./schema"
import * as Events from "./events"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"
import { randomUUID } from "node:crypto"

const STUCK_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
const SCAN_INTERVAL_MS = 60 * 1000 // every 60s

// Identifies the registering process; a different token does not prove termination.
const PROCESS_INSTANCE_ID = randomUUID()

/**
 * Persist terminal state for other-instance running/pending actors that have
 * been silent past the abandon threshold, then settle orphaned running
 * question tool parts.
 *
 * Live execution = `running` (any actor id, including main) or non-main
 * `pending`. The `pending main` row seeded by Session.create is not live.
 *
 * Question reclaim uses the same abandon-threshold tradeoff as actor rows:
 * a fiber blocked on an unanswered question writes no parts, so after the
 * threshold another instance may reclaim both the actor row and its open
 * question parts. Orphan discovery is not limited to sessions settled in
 * this pass — already-terminal leftover questions are repaired too.
 *
 * Called on registry layer init; tests may invoke after seeding zombie rows.
 */
export function sweepAbandonedZombies(): void {
  const cutoff = Date.now() - DEFAULT_LIVENESS_ABANDON_MS
  Database.use((db) => {
    const isLiveActor = (row: { actor_id: string; status: string }): boolean => {
      if (row.status === "running") return true
      // pending main is the Session.create seed, not an executing fiber
      if (row.status === "pending" && row.actor_id !== "main") return true
      return false
    }

    const abandoned = db
      .select()
      .from(ActorRegistryTable)
      .all()
      .filter((row) => row.status === "running" || row.status === "pending")
      .filter((row) => row.instance_id !== PROCESS_INSTANCE_ID)
      .filter((row) => (row.last_activity_time ?? row.time_created) < cutoff)

    for (const row of abandoned) {
      db.update(ActorRegistryTable)
        .set({
          status: "idle",
          last_outcome: "failure",
          last_error:
            "Process restarted while actor was active; settled by abandon threshold. Not final — actor send can recover.",
          time_completed: Date.now(),
          time_updated: Date.now(),
        })
        .where(and(eq(ActorRegistryTable.session_id, row.session_id), eq(ActorRegistryTable.actor_id, row.actor_id)))
        .run()
    }

    const end = Date.now()
    const orphanQuestionError =
      "This question was left open by a process instance that is no longer live; settled by abandon threshold. The card is cancelled — send a new message to continue."

    const actorsAfter = db.select().from(ActorRegistryTable).all()
    const openQuestions = db
      .select()
      .from(PartTable)
      .all()
      .filter((row) => {
        const data = row.data as {
          type?: string
          tool?: string
          state?: { status?: string }
        }
        return (
          data?.type === "tool" &&
          data?.tool === "question" &&
          (data.state?.status === "running" || data.state?.status === "pending")
        )
      })

    for (const row of openQuestions) {
      const sessionActors = actorsAfter.filter((a) => a.session_id === row.session_id)
      if (sessionActors.some(isLiveActor)) continue
      const data = row.data as {
        type?: string
        tool?: string
        state?: { status?: string; error?: string; time?: Record<string, unknown> }
      }
      const state = data.state && typeof data.state === "object" ? data.state : {}
      const time = state.time && typeof state.time === "object" ? state.time : {}
      db.update(PartTable)
        .set({
          data: {
            ...data,
            state: {
              ...state,
              status: "error",
              error: orphanQuestionError,
              time: { ...time, end: end },
            },
          } as never,
          time_updated: end,
        })
        .where(eq(PartTable.id, row.id))
        .run()
    }
  })
}

type ActorRow = typeof ActorRegistryTable.$inferSelect

function fromRow(row: ActorRow): Actor {
  return {
    sessionID: row.session_id,
    actorID: row.actor_id,
    mode: row.mode,
    parentActorID: row.parent_actor_id ?? undefined,
    status: row.status,
    lastOutcome: row.last_outcome ?? undefined,
    ...(row.result_message_id ? { resultMessageID: row.result_message_id } : {}),
    lifecycle: row.lifecycle,
    agent: row.agent,
    description: row.description,
    contextMode: row.context_mode,
    contextWatermark: row.context_watermark ?? undefined,
    background: Boolean(row.background),
    tools: row.tools ?? undefined,
    lastTurnTime: row.last_turn_time,
    turnCount: row.turn_count,
    lastActivityTime: row.last_activity_time ?? undefined,
    lastError: row.last_error ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      completed: row.time_completed ?? undefined,
    },
  }
}

export interface Interface {
  readonly register: (input: {
    sessionID: SessionID
    actorID: string
    mode: SpawnMode
    parentActorID?: string
    agent: string
    description: string
    contextMode: ContextMode
    contextWatermark?: MessageID
    background: boolean
    lifecycle: Lifecycle
    tools?: ToolWhitelist
  }) => Effect.Effect<Actor>

  readonly updateStatus: (
    sessionID: SessionID,
    actorID: string,
    patch: {
      status: ActorStatus
      lastOutcome?: ActorOutcome | undefined
      lastError?: string | undefined
      resultMessageID?: MessageID | undefined
    },
  ) => Effect.Effect<void>
  readonly updateTurn: (sessionID: SessionID, actorID: string) => Effect.Effect<void>
  readonly updateAgent: (sessionID: SessionID, actorID: string, agent: string) => Effect.Effect<void>
  readonly get: (sessionID: SessionID, actorID: string) => Effect.Effect<Actor | undefined>
  // Derived pull-side liveness for a single actor row (progressing/stalled/
  // terminal), computed from honest registry fields. Returns undefined when the
  // row is absent. Pass stallMs to override the default staleness window.
  readonly liveness: (
    sessionID: SessionID,
    actorID: string,
    stallMs?: number,
  ) => Effect.Effect<{ liveness: Liveness; actor: Actor } | undefined>
  readonly listBySession: (sessionID: SessionID) => Effect.Effect<Actor[]>
  readonly listActive: () => Effect.Effect<Actor[]>
  readonly listByParent: (sessionID: SessionID, parentActorID: string) => Effect.Effect<Actor[]>
  // Peer CHILD sessions of a parent session, joined to their session title.
  // Peers key their registry row by their own child session id, so the parent
  // link lives on the Session row (parent_id) — not on session_id here.
  readonly listPeerChildren: (
    parentSessionID: SessionID,
    parentActorID: string,
  ) => Effect.Effect<{ actor: Actor; title: string }[]>
  readonly renderForAgent: (sessionID: SessionID) => Effect.Effect<string>
  readonly agentTypeFor: (sessionID: SessionID, actorID: string) => Effect.Effect<string>
  readonly isSystemSpawned: (sessionID: SessionID, actorID: string) => Effect.Effect<boolean>
  readonly servesCheckpoint: (sessionID: SessionID, actorID: string | undefined) => Effect.Effect<boolean>
  readonly allocateActorID: (sessionID: SessionID, agentType: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ActorRegistry") {}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    // Layer rebuilds retain the same process identity.
    // This is stable across layer rebuilds within the same process.
    const instanceID = PROCESS_INSTANCE_ID

    // --- CRUD methods ---

    const register = Effect.fn("ActorRegistry.register")(function* (input: {
      sessionID: SessionID
      actorID: string
      mode: SpawnMode
      parentActorID?: string
      agent: string
      description: string
      contextMode: ContextMode
      contextWatermark?: MessageID
      background: boolean
      lifecycle: Lifecycle
      tools?: ToolWhitelist
    }) {
      const now = Date.now()
      const row = {
        session_id: input.sessionID,
        actor_id: input.actorID,
        mode: input.mode,
        parent_actor_id: input.parentActorID ?? null,
        status: "pending" as const,
        last_outcome: null,
        result_message_id: null,
        lifecycle: input.lifecycle,
        agent: input.agent,
        description: input.description,
        context_mode: input.contextMode,
        context_watermark: input.contextWatermark ?? null,
        background: input.background,
        tools: input.tools ?? null,
        last_turn_time: now,
        turn_count: 0,
        // No part has landed for this actor yet. NULL, not `now`: deriveLiveness
        // falls back to time_created when activity is absent, so seeding a fake
        // activity timestamp here would assert something happened that did not.
        last_activity_time: null,
        last_error: null,
        instance_id: instanceID,
        time_completed: null,
        time_created: now,
        time_updated: now,
      }
      yield* Effect.sync(() => Database.use((db) => db.insert(ActorRegistryTable).values(row).run()))
      yield* bus.publish(Events.ActorRegistered, {
        sessionID: input.sessionID,
        actorID: input.actorID,
        mode: input.mode,
        parentActorID: input.parentActorID,
        description: input.description,
        agent: input.agent,
        background: input.background,
      })
      return fromRow(row)
    })

    const updateStatus = Effect.fn("ActorRegistry.updateStatus")(function* (
      sessionID: SessionID,
      actorID: string,
      patch: {
        status: ActorStatus
        lastOutcome?: ActorOutcome | undefined
        lastError?: string | undefined
        resultMessageID?: MessageID | undefined
      },
    ) {
      const now = Date.now()
      const isTerminal = patch.status === "idle" && patch.lastOutcome !== undefined
      // Running clears result_message_id so a wait in flight cannot resolve
      // against a delivery from the previous turn. Terminal writes the new
      // pointer (or null when settle produced no delivery) — a failure without
      // output must not reuse an older success (TP-R14-11).
      const set: Record<string, unknown> = {
        status: patch.status,
        time_updated: now,
        ...(isTerminal ? { time_completed: now, result_message_id: patch.resultMessageID ?? null } : {}),
        ...(patch.status === "running" ? { result_message_id: null } : {}),
      }
      if (patch.lastOutcome !== undefined) set.last_outcome = patch.lastOutcome
      if (patch.lastError !== undefined) set.last_error = patch.lastError
      else if (patch.lastOutcome !== undefined && patch.lastOutcome !== "failure") set.last_error = null
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(ActorRegistryTable)
            .set(set)
            .where(and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)))
            .run(),
        ),
      )
      // Re-read so the event payload reflects committed row values (not the
      // sparse patch). Skip publish if the row vanished between UPDATE and
      // SELECT — a dropped event beats a misleading one.
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ActorRegistryTable)
            .where(and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)))
            .get(),
        ),
      )
      if (!row) return
      yield* bus.publish(Events.ActorStatusChanged, {
        sessionID,
        actorID,
        status: row.status,
        ...(row.last_outcome ? { lastOutcome: row.last_outcome } : {}),
        turnCount: row.turn_count,
        lastTurnTime: row.last_turn_time,
        ...(row.last_error ? { error: row.last_error } : {}),
      })
    })

    const updateTurn = Effect.fn("ActorRegistry.updateTurn")(function* (sessionID: SessionID, actorID: string) {
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(ActorRegistryTable)
            .set({
              last_turn_time: now,
              turn_count: sql`${ActorRegistryTable.turn_count} + 1`,
              time_updated: now,
            })
            .where(and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)))
            .run(),
        ),
      )
    })

    const updateAgent = Effect.fn("ActorRegistry.updateAgent")(function* (
      sessionID: SessionID,
      actorID: string,
      agent: string,
    ) {
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(ActorRegistryTable)
            .set({ agent, time_updated: Date.now() })
            .where(and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)))
            .run(),
        ),
      )
    })

    const get = Effect.fn("ActorRegistry.get")(function* (sessionID: SessionID, actorID: string) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ActorRegistryTable)
            .where(and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)))
            .get(),
        ),
      )
      return row ? fromRow(row) : undefined
    })

    const liveness = Effect.fn("ActorRegistry.liveness")(function* (
      sessionID: SessionID,
      actorID: string,
      stallMs?: number,
    ) {
      const actor = yield* get(sessionID, actorID)
      if (!actor) return undefined
      return { liveness: deriveLiveness(actor, Date.now(), stallMs), actor }
    })

    const listBySession = Effect.fn("ActorRegistry.listBySession")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(ActorRegistryTable).where(eq(ActorRegistryTable.session_id, sessionID)).all(),
        ),
      )
      return rows.map(fromRow)
    })

    const listActive = Effect.fn("ActorRegistry.listActive")(function* () {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ActorRegistryTable)
            .where(
              and(inArray(ActorRegistryTable.status, ["pending", "running"]), eq(ActorRegistryTable.background, true)),
            )
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    const listByParent = Effect.fn("ActorRegistry.listByParent")(function* (
      sessionID: SessionID,
      parentActorID: string,
    ) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ActorRegistryTable)
            .where(
              and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.parent_actor_id, parentActorID)),
            )
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    // Peer children register with session_id === actor_id === their OWN child
    // session id (Actor.spawnPeer), so listByParent — which filters on
    // session_id === the parent's id — can never match them. The reliable
    // parent link is the Session row's parent_id. Join on it so a caller with
    // no Session.Service (e.g. the LLM layer building the orchestrator's
    // fleet roster) can still enumerate its peer children, and
    // carry the child's title along since that is the routing signal.
    const listPeerChildren = Effect.fn("ActorRegistry.listPeerChildren")(function* (
      parentSessionID: SessionID,
      parentActorID: string,
    ) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ actor: ActorRegistryTable, title: SessionTable.title })
            .from(ActorRegistryTable)
            .innerJoin(SessionTable, eq(SessionTable.id, ActorRegistryTable.session_id))
            .where(
              and(
                eq(SessionTable.parent_id, parentSessionID),
                eq(ActorRegistryTable.mode, "peer"),
                eq(ActorRegistryTable.parent_actor_id, parentActorID),
              ),
            )
            .all(),
        ),
      )
      return rows.map((row) => ({ actor: fromRow(row.actor), title: row.title }))
    })

    const renderForAgent = Effect.fn("ActorRegistry.renderForAgent")(function* (sessionID: SessionID) {
      const actors = yield* listBySession(sessionID)
      const active = actors.filter(
        (actor) => actor.background && (actor.status === "pending" || actor.status === "running"),
      )
      if (active.length === 0) return ""

      const lines: string[] = []
      lines.push("## Active Actors")
      lines.push("")
      lines.push(`You have ${active.length} background actor(s) registered. Interact via the \`actor\` tool.`)
      lines.push("")
      const now = Date.now()
      for (const actor of active) {
        const idleMs = now - actor.lastTurnTime
        const idle = idleMs < 60_000 ? `${Math.floor(idleMs / 1000)}s` : `${Math.floor(idleMs / 60_000)}m`
        lines.push(`- actor_id: ${actor.actorID} (${actor.status}, last activity ${idle} ago)`)
        lines.push(`  description: ${actor.description}`)
        lines.push(`  agent: ${actor.agent}`)
      }
      return lines.join("\n")
    })

    const agentTypeFor = Effect.fn("ActorRegistry.agentTypeFor")(function* (sessionID: SessionID, actorID: string) {
      if (actorID === "main") return "main"
      const actor = yield* get(sessionID, actorID)
      return actor?.agent ?? "main"
    })

    const isSystemSpawned = Effect.fn("ActorRegistry.isSystemSpawned")(function* (
      sessionID: SessionID,
      actorID: string,
    ) {
      if (actorID === "main") return false
      const actor = yield* get(sessionID, actorID)
      if (!actor) return false
      return SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent)
    })

    // Whether this actor's context is maintained by the session checkpoint flow.
    // Checkpoint serves main + peer only; subagents use per-actor compaction, and
    // system-spawned agents (checkpoint-writer/dream/distill) maintain nothing.
    // Single source of truth for both the memory-instructions gate (LLM.buildSystemArray)
    // and the checkpoint self-trigger gate (SessionPrune.fireCheckpoints). Two
    // orthogonal exclusions kept explicit (agent TYPE vs MODE) so a future system
    // agent spawned as mode:"peer" can't silently slip back in — see prune.ts.
    const servesCheckpoint = Effect.fn("ActorRegistry.servesCheckpoint")(function* (
      sessionID: SessionID,
      actorID: string | undefined,
    ) {
      // No agentID (or literal "main") → main runLoop. Fail open: main and peer
      // must never silently lose checkpoints / memory instructions. "main" has no
      // registry row, so short-circuit before the read.
      if (!actorID || actorID === "main") return true
      // Single read, two orthogonal exclusions derived from it: agent TYPE
      // (system-spawned) and actor MODE (subagent). Unregistered/race → fail open.
      const actor = yield* get(sessionID, actorID)
      if (!actor) return true
      if (SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent)) return false
      return actor.mode !== "subagent"
    })

    const allocateActorID = Effect.fn("ActorRegistry.allocateActorID")(function* (
      sessionID: SessionID,
      agentType: string,
    ) {
      const existing = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ actor_id: ActorRegistryTable.actor_id })
            .from(ActorRegistryTable)
            .where(and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.agent, agentType)))
            .all(),
        ),
      )
      const prefix = `${agentType}-`
      let max = 0
      for (const row of existing) {
        if (row.actor_id.startsWith(prefix)) {
          const n = parseInt(row.actor_id.slice(prefix.length), 10)
          if (Number.isFinite(n) && n > max) max = n
        }
      }
      return `${agentType}-${max + 1}`
    })

    // Initialization cannot infer execution failure from another instance ID.
    // Only the executor settles its turn; stuck detection remains advisory.
    //
    // Time-based zombie sweep: a crashed process leaves running/pending rows
    // that nothing will ever settle. deriveLiveness already returns "idle" for
    // them at read time (abandon threshold), but the DB row stays non-terminal
    // and ActorWaiter only resolves on status==='idle'. Persist the terminal
    // state once at init so restarts don't leave parents waiting forever.
    // Exclude this process's instance_id: a same-process layer rebuild must
    // never settle a still-running fiber that merely has not written a part
    // for >abandon (long LLM step). Other-instance abandoned rows are fair
    // game — their process is gone or silent past the abandon threshold.
    //
    // Open question tool parts die with the fiber: the in-memory Deferred is
    // gone, but part.state stays running. Clients keep the card pending and
    // free-text answers hit "unknown request". After the registry rows settle,
    // if a session has no remaining live actor, settle those orphan question
    // parts to error so history/UI treat them as cancelled.
    yield* Effect.sync(sweepAbandonedZombies).pipe(Effect.ignore)

    // --- Stuck Detection ---
    const scanStuck = Effect.gen(function* () {
      const cutoff = Date.now() - STUCK_THRESHOLD_MS
      const stuck = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ActorRegistryTable)
            .where(and(eq(ActorRegistryTable.status, "running"), lte(ActorRegistryTable.last_turn_time, cutoff)))
            .all(),
        ),
      )
      for (const row of stuck) {
        const entry = fromRow(row)
        yield* bus.publish(Events.ActorStuck, {
          sessionID: entry.sessionID,
          actorID: entry.actorID,
          description: entry.description,
          lastTurnTime: entry.lastTurnTime,
          stuckDuration: Date.now() - entry.lastTurnTime,
        })
      }
    })

    // Fork stuck detection fiber in the layer scope
    yield* scanStuck.pipe(Effect.repeat(Schedule.fixed(SCAN_INTERVAL_MS)), Effect.ignore, Effect.forkScoped)

    return Service.of({
      register,
      updateStatus,
      updateTurn,
      updateAgent,
      get,
      liveness,
      listBySession,
      listActive,
      listByParent,
      listPeerChildren,
      renderForAgent,
      agentTypeFor,
      isSystemSpawned,
      servesCheckpoint,
      allocateActorID,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as ActorRegistry from "./registry"
