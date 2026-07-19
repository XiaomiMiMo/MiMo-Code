import { Effect, Layer, Context, Schedule } from "effect"
import { Database, inArray, eq, and, lte, sql } from "@/storage"
import { Bus } from "@/bus"
import type { SessionID, MessageID } from "@/session/schema"
import { ActorRegistryTable } from "./actor.sql"
import type { Actor, ActorStatus, ActorOutcome, ContextMode, Lifecycle, SpawnMode, ToolWhitelist, Liveness } from "./schema"
import { deriveLiveness } from "./schema"
import * as Events from "./events"
import { Log } from "@/util"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"
import { randomUUID } from "node:crypto"

const log = Log.create({ service: "actor.registry" })

const STUCK_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
const SCAN_INTERVAL_MS = 60 * 1000 // every 60s

// Process-level singleton instance ID for orphan recovery.
// A unique token generated once at module load. Stable across layer rebuilds
// within the same process; a fresh process gets a new token and correctly
// reclaims dead rows.
const PROCESS_INSTANCE_ID = randomUUID()

type ActorRow = typeof ActorRegistryTable.$inferSelect

function fromRow(row: ActorRow): Actor {
  return {
    sessionID: row.session_id,
    actorID: row.actor_id,
    mode: row.mode,
    parentActorID: row.parent_actor_id ?? undefined,
    status: row.status,
    lastOutcome: row.last_outcome ?? undefined,
    lifecycle: row.lifecycle,
    agent: row.agent,
    description: row.description,
    contextMode: row.context_mode,
    contextWatermark: row.context_watermark ?? undefined,
    background: Boolean(row.background),
    tools: row.tools ?? undefined,
    lastTurnTime: row.last_turn_time,
    turnCount: row.turn_count,
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

    // Use the process-level singleton for orphan recovery.
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
        lifecycle: input.lifecycle,
        agent: input.agent,
        description: input.description,
        context_mode: input.contextMode,
        context_watermark: input.contextWatermark ?? null,
        background: input.background,
        tools: input.tools ?? null,
        last_turn_time: now,
        turn_count: 0,
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
      },
    ) {
      const now = Date.now()
      const isTerminal = patch.status === "idle" && patch.lastOutcome !== undefined
      const set: Record<string, unknown> = {
        status: patch.status,
        time_updated: now,
        ...(isTerminal ? { time_completed: now } : {}),
      }
      if (patch.lastOutcome !== undefined) set.last_outcome = patch.lastOutcome
      if (patch.lastError !== undefined) set.last_error = patch.lastError
      else if (patch.lastOutcome !== undefined && patch.lastOutcome !== "failure") set.last_error = null
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(ActorRegistryTable)
            .set(set)
            .where(
              and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
            )
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
            .where(
              and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
            )
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
            .where(
              and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
            )
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
            .where(
              and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
            )
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
            .where(
              and(eq(ActorRegistryTable.session_id, sessionID), eq(ActorRegistryTable.actor_id, actorID)),
            )
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
              and(
                inArray(ActorRegistryTable.status, ["pending", "running"]),
                eq(ActorRegistryTable.background, true),
              ),
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
              and(
                eq(ActorRegistryTable.session_id, sessionID),
                eq(ActorRegistryTable.parent_actor_id, parentActorID),
              ),
            )
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    const renderForAgent = Effect.fn("ActorRegistry.renderForAgent")(function* (sessionID: SessionID) {
      const actors = yield* listBySession(sessionID)
      const active = actors.filter((actor) => actor.background && (actor.status === "pending" || actor.status === "running"))
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

    const agentTypeFor = Effect.fn("ActorRegistry.agentTypeFor")(function* (
      sessionID: SessionID,
      actorID: string,
    ) {
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

    // --- Orphan Recovery ---
    // On init, mark pending/running actors from a PREVIOUS process as idle
    // with failure outcome. Actors from this very instance (same instanceID)
    // are still alive and must NOT be touched.
    yield* Effect.sync(() =>
      Database.use((db) => {
        const now = Date.now()
        db.run(sql`
          UPDATE actor_registry
          SET status = 'idle',
              last_outcome = 'failure',
              last_error = 'orphaned: process restarted',
              time_updated = ${now},
              time_completed = ${now}
          WHERE status IN ('pending', 'running')
            AND instance_id != ${instanceID}
        `)
      }),
    )
    log.info("orphan recovery complete", { instanceID })

    // --- Stuck Detection ---
    const scanStuck = Effect.gen(function* () {
      const cutoff = Date.now() - STUCK_THRESHOLD_MS
      const stuck = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(ActorRegistryTable)
            .where(
              and(
                eq(ActorRegistryTable.status, "running"),
                lte(ActorRegistryTable.last_turn_time, cutoff),
              ),
            )
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
    yield* scanStuck.pipe(
      Effect.repeat(Schedule.fixed(SCAN_INTERVAL_MS)),
      Effect.ignore,
      Effect.forkScoped,
    )

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
