import z from "zod"
import { SessionID, MessageID } from "@/session/schema"

export const ActorStatus = z.enum(["pending", "running", "idle"])
export type ActorStatus = z.infer<typeof ActorStatus>

export const ActorOutcome = z.enum(["success", "failure", "cancelled"])
export type ActorOutcome = z.infer<typeof ActorOutcome>

export const Lifecycle = z.enum(["ephemeral", "persistent"])
export type Lifecycle = z.infer<typeof Lifecycle>

export const ContextMode = z.enum(["none", "state", "full"])
export type ContextMode = z.infer<typeof ContextMode>

export const SpawnMode = z.enum(["peer", "subagent", "main"])
export type SpawnMode = z.infer<typeof SpawnMode>

export const ToolWhitelist = z.union([z.array(z.string()).readonly(), z.literal("INHERIT")])
export type ToolWhitelist = z.infer<typeof ToolWhitelist>

export const Actor = z
  .object({
    sessionID: SessionID.zod,
    actorID: z.string(),
    mode: SpawnMode,
    parentActorID: z.string().optional(),
    status: ActorStatus,
    lastOutcome: ActorOutcome.optional(),
    lifecycle: Lifecycle,
    agent: z.string(),
    description: z.string(),
    contextMode: ContextMode,
    contextWatermark: MessageID.zod.optional(),
    background: z.boolean(),
    tools: ToolWhitelist.optional(),
    lastTurnTime: z.number(),
    turnCount: z.number(),
    lastError: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      completed: z.number().optional(),
    }),
  })
  .meta({ ref: "Actor" })
export type Actor = z.infer<typeof Actor>

// Derived liveness: a pull-side signal computed from an actor row's honest
// registry fields (status, lastOutcome, lastTurnTime). It answers the question
// raw `status` cannot — is a running child PROGRESSING or STALLED?
//   - progressing: running/pending AND its last turn advanced within the
//     staleness window (updateTurn bumps last_turn_time per step, so a recent
//     last_turn_time == recent progress). Also covers a not-yet-started child
//     (turnCount === 0): its last_turn_time is the spawn time, so a slow first
//     turn (queued behind the concurrency gate, model cold-start) must NOT be
//     mistaken for a stall — it has not had the chance to run even once.
//   - stalled: running/pending, HAS run at least one turn, BUT no turn advance
//     for longer than the window.
//   - success | failure | cancelled: terminal, taken straight from lastOutcome.
//   - idle: finished with no recorded outcome (or an unknown state).
// Never fabricates: every value maps 1:1 to fields the engine actually wrote.
export const Liveness = z.enum(["progressing", "stalled", "success", "failure", "cancelled", "idle"])
export type Liveness = z.infer<typeof Liveness>

// Default staleness threshold: a running child with no turn advance for this
// long is reported `stalled`. 90s sits between the per-step turn cadence and
// the 5-minute stuck-detection cutoff, so a briefly-thinking child still reads
// as progressing while a genuinely wedged one flips to stalled well before the
// watchdog (T40) would fire.
export const DEFAULT_LIVENESS_STALL_MS = 90_000

export function deriveLiveness(
  actor: Pick<Actor, "status" | "lastOutcome" | "lastTurnTime" | "turnCount">,
  now: number = Date.now(),
  stallMs: number = DEFAULT_LIVENESS_STALL_MS,
): Liveness {
  if (actor.status === "running" || actor.status === "pending") {
    // Not-yet-started child (no turn completed): last_turn_time is the spawn
    // time, so a slow first turn (queued/cold-start) is not a stall.
    if (actor.turnCount === 0) return "progressing"
    return now - actor.lastTurnTime <= stallMs ? "progressing" : "stalled"
  }
  if (actor.lastOutcome === "success") return "success"
  if (actor.lastOutcome === "failure") return "failure"
  if (actor.lastOutcome === "cancelled") return "cancelled"
  return "idle"
}
